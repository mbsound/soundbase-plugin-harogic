/*
 * harogic-worker: one Harogic analyzer, driven over JSON lines on stdio.
 *
 * The plugin process never calls the Harogic SDK itself. A vendor call that
 * wedges (cable pulled mid-transfer, a network analyzer that stops answering
 * part-way through its handshake) blocks this process instead, and the driver
 * SIGKILLs it. It also lets the driver pick which SDK build to load: each
 * build only opens analyzers whose firmware matches it, and two builds cannot
 * share a process.
 *
 * Requests, one JSON object per line on stdin:
 *   {"id":1,"op":"hello"}
 *   {"id":2,"op":"open","iface":"usb","index":0}
 *   {"id":2,"op":"open","iface":"eth","ip":"192.168.1.100","port":5000}
 *   {"id":3,"op":"config","startHz":470e6,"stopHz":616e6,"pointCount":1461,
 *          "rbwHz":0,"refLevelDbm":-30,"atten":-1,"preamp":0,"detector":1,
 *          "spur":1}
 *   {"id":4,"op":"sweep"}
 *   {"id":5,"op":"status"}
 *   {"id":6,"op":"close"}
 *
 * Replies: {"id":n,"ok":true,"result":{...}} or
 *          {"id":n,"ok":false,"code":<SDK status>,"error":"..."}
 *
 * EOF on stdin closes the analyzer and exits, so a worker whose plugin died
 * never keeps the analyzer's only session.
 *
 * MOCK: HAROGIC_WORKER_MOCK=1 serves a synthetic analyzer without calling the
 * SDK (the library is still loaded, so the packaging is exercised).
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "htra_api.h"

#ifndef SDK_LABEL
#define SDK_LABEL "unknown"
#endif

/* ---------------------------------------------------------------- JSON in */

/* Requests are flat objects of numbers, strings and booleans. */
static const char *find_key(const char *line, const char *key) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = line;
    while ((p = strstr(p, pat))) {
        const char *q = p + strlen(pat);
        while (*q == ' ' || *q == '\t') q++;
        if (*q == ':') {
            q++;
            while (*q == ' ' || *q == '\t') q++;
            return q;
        }
        p = q;
    }
    return NULL;
}

static double get_num(const char *line, const char *key, double dflt) {
    const char *v = find_key(line, key);
    if (!v) return dflt;
    if (!strncmp(v, "true", 4)) return 1;
    if (!strncmp(v, "false", 5) || !strncmp(v, "null", 4)) return dflt;
    char *end;
    double d = strtod(v, &end);
    return end == v ? dflt : d;
}

static bool get_str(const char *line, const char *key, char *out, size_t n) {
    const char *v = find_key(line, key);
    if (!v || *v != '"') return false;
    v++;
    size_t i = 0;
    while (*v && *v != '"' && i + 1 < n) out[i++] = *v++;
    out[i] = 0;
    return true;
}

/* --------------------------------------------------------------- JSON out */

static void reply_err(long id, int code, const char *msg) {
    printf("{\"id\":%ld,\"ok\":false,\"code\":%d,\"error\":\"", id, code);
    for (const char *p = msg; *p; p++) {
        if (*p == '"' || *p == '\\') putchar('\\');
        putchar(*p == '\n' ? ' ' : *p);
    }
    printf("\"}\n");
    fflush(stdout);
}

/* Amplitudes to 0.01 dB: enough for any display, and a fraction of %g's size. */
static void print_amps(const float *a, int n) {
    putchar('[');
    for (int i = 0; i < n; i++) {
        if (i) putchar(',');
        float v = a[i];
        if (!isfinite(v)) v = -200;
        printf("%.2f", v);
    }
    putchar(']');
}

/* ----------------------------------------------------------------- state */

static void *dev;
static bool is_open, mock, debug;
static uint16_t model;

static SWP_Profile_TypeDef prof_in, prof_out;
static SWP_TraceInfo_TypeDef ti;
static bool configured;
static double user_start, user_stop; /* the grid SoundBase draws */
static int out_points;

static double *nat_freq, *hop_freq;
static float *nat_pwr, *prev_pwr, *out_pwr, *hop_pwr;
static int nat_cap;
static bool have_prev;

static int16_t last_temp;
static int mock_sweeps;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

#define HOP_SCRATCH 65536

static void ensure_native(int n) {
    if (!hop_freq) {
        hop_freq = calloc(HOP_SCRATCH, sizeof(double));
        hop_pwr = calloc(HOP_SCRATCH, sizeof(float));
    }
    if (n <= nat_cap) return;
    nat_freq = realloc(nat_freq, sizeof(double) * n);
    nat_pwr = realloc(nat_pwr, sizeof(float) * n);
    prev_pwr = realloc(prev_pwr, sizeof(float) * n);
    nat_cap = n;
    have_prev = false;
}

/* ------------------------------------------------------------------ ops */

static void op_hello(long id) {
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"api\":%u,\"sdk\":\"%s\",\"mock\":%s}}\n", id,
           (unsigned)Get_APIVersion(), SDK_LABEL, mock ? "true" : "false");
    fflush(stdout);
}

static bool parse_ip(const char *s, uint8_t out[4]) {
    unsigned a, b, c, d;
    if (sscanf(s, "%u.%u.%u.%u", &a, &b, &c, &d) != 4 || a > 255 || b > 255 || c > 255 || d > 255)
        return false;
    out[0] = a, out[1] = b, out[2] = c, out[3] = d;
    return true;
}

static void op_open(long id, const char *line) {
    if (is_open) {
        reply_err(id, -1, "already open");
        return;
    }
    char iface[8] = "usb", ip[64] = "";
    get_str(line, "iface", iface, sizeof iface);
    bool eth = !strcmp(iface, "eth");

    BootInfo_TypeDef info;
    memset(&info, 0, sizeof info);
    double t0 = now_s();
    int st = 0;
    if (mock) {
        info.DeviceInfo.Model = eth ? 0x43 : 0x42;
        info.DeviceInfo.DeviceUID = eth ? 0x4D4F434B4E4554ULL : 0x4D4F434B555342ULL;
        info.DeviceInfo.MFWVersion = 0x376d;
        info.BusSpeed = eth ? 0 : 3;
    } else {
        BootProfile_TypeDef boot;
        memset(&boot, 0, sizeof boot);
        if (eth) {
            if (!get_str(line, "ip", ip, sizeof ip) || !parse_ip(ip, boot.ETH_IPAddress)) {
                reply_err(id, -1, "open over Ethernet needs an IPv4 address");
                return;
            }
            boot.PhysicalInterface = ETH;
            boot.DevicePowerSupply = Others;
            boot.ETH_IPVersion = IPv4;
            boot.ETH_RemotePort = (uint16_t)get_num(line, "port", 5000);
            boot.ETH_ReadTimeOut = (int32_t)get_num(line, "readTimeoutMs", 5000);
        } else {
            boot.PhysicalInterface = USB;
            boot.DevicePowerSupply = USBPortAndPowerPort;
        }
        /* USB: the index is a guess from the order macOS lists the analyzers
           in. When the caller knows the serial it wants ("expectUid": the
           low 64 bits of the UID, which is the tail of the USB serial string),
           open by index, check, and move to the next index on a mismatch. */
        char want[32] = "";
        get_str(line, "expectUid", want, sizeof want);
        unsigned long long want_uid = want[0] ? strtoull(want, NULL, 16) : 0;
        int index = (int)get_num(line, "index", 0);
        int tried = 0;
        for (;;) {
            st = Device_Open(&dev, index, &boot, &info);
            /* Anything but 0 is a failed open: negative SDK errors, and positive
               socket errors over Ethernet (10060: the analyzer did not answer).
               The handle is then unusable; even Device_Close on it crashes. */
            if (st != 0) {
                dev = NULL;
                break;
            }
            if (eth || !want_uid || info.DeviceInfo.DeviceUID == want_uid) break;
            fprintf(stderr, "index %d is analyzer %016llx, not %016llx; trying the next\n", index,
                    (unsigned long long)info.DeviceInfo.DeviceUID, want_uid);
            Device_Close(&dev);
            dev = NULL;
            if (++tried >= 8) {
                st = -1;
                break;
            }
            index = (index + 1) % 8;
        }
        if (st != 0) {
            char msg[160];
            snprintf(msg, sizeof msg, "Device_Open returned %d (firmware 0x%x)", st,
                     (unsigned)info.DeviceInfo.MFWVersion);
            reply_err(id, st, msg);
            return;
        }
    }
    is_open = true;
    model = info.DeviceInfo.Model;
    uint64_t funcs = 0;
    if (!mock) Device_GetSupportedFunctions(&dev, &funcs);
    configured = false;
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"status\":%d,\"model\":%u,\"uid\":\"%016llx\","
           "\"hardware\":%u,\"mcuFirmware\":%u,\"fpgaFirmware\":%u,\"busSpeed\":%u,\"api\":%u,"
           "\"sdk\":\"%s\",\"openSeconds\":%.2f,\"ifagcSupported\":%s,\"warnings\":[",
           id, st, model, (unsigned long long)info.DeviceInfo.DeviceUID,
           info.DeviceInfo.HardwareVersion, (unsigned)info.DeviceInfo.MFWVersion,
           (unsigned)info.DeviceInfo.FFWVersion, (unsigned)info.BusSpeed,
           (unsigned)Get_APIVersion(), SDK_LABEL, now_s() - t0,
           (funcs & (1ULL << 34)) /* DEVICE_FUNCTION_IFAGC; the SDK macro is C++ syntax */ ? "true" : "false");
    for (int i = 0; i < info.Warnings && i < 7; i++) printf("%s%d", i ? "," : "", info.WarningCodes[i]);
    printf("]}}\n");
    fflush(stdout);
}

static void op_config(long id, const char *line) {
    if (!is_open) {
        reply_err(id, -1, "not open");
        return;
    }
    double start = get_num(line, "startHz", 470e6), stop = get_num(line, "stopHz", 616e6);
    int points = (int)get_num(line, "pointCount", 1001);
    if (points < 2) points = 2;
    if (stop <= start) stop = start + 1e3;
    double rbw = get_num(line, "rbwHz", 0);
    bool fallback = false;
    int first_status = 0;

    if (mock) {
        memset(&prof_out, 0, sizeof prof_out);
        prof_out.StartFreq_Hz = start;
        prof_out.StopFreq_Hz = stop;
        prof_out.RBW_Hz = rbw > 0 ? rbw : (stop - start) / 2000;
        prof_out.VBW_Hz = prof_out.RBW_Hz;
        prof_out.RefLevel_dBm = get_num(line, "refLevelDbm", -30);
        prof_out.Atten = (int8_t)get_num(line, "atten", -1);
        memset(&ti, 0, sizeof ti);
        ti.TotalHops = 1;
        ti.FullsweepTracePoints = ti.PartialsweepTracePoints = 4001;
        ti.EstimateMinSweepTime = 0.02;
    } else {
        SWP_ProfileDeInit(&dev, &prof_in);
        prof_in.StartFreq_Hz = start;
        prof_in.StopFreq_Hz = stop;
        prof_in.CenterFreq_Hz = (start + stop) / 2;
        prof_in.Span_Hz = stop - start;
        prof_in.FreqAssignment = StartStop;
        if (rbw > 0) {
            prof_in.RBWMode = RBW_Manual;
            prof_in.RBW_Hz = rbw;
        } else {
            prof_in.RBWMode = RBW_Auto;
        }
        prof_in.VBWMode = VBW_EqualToRBW;
        prof_in.RefLevel_dBm = get_num(line, "refLevelDbm", prof_in.RefLevel_dBm);
        prof_in.Atten = (int8_t)get_num(line, "atten", -1);
        prof_in.Preamplifier = (PreamplifierState_TypeDef)(int)get_num(line, "preamp", AutoOn);
        prof_in.Detector = (Detector_TypeDef)(int)get_num(line, "detector", prof_in.Detector);
        prof_in.TraceDetector = (TraceDetector_TypeDef)(int)get_num(line, "traceDetector", TraceDetector_PosPeak);
        prof_in.SpurRejection = (SpurRejection_TypeDef)(int)get_num(line, "spur", prof_in.SpurRejection);
        prof_in.TraceAlign = AlignToStart;
        /* IF AGC: the SDK lowers IF gain when the IF saturates, instead of
           clipping (supported on some models; DEVICE_FUNCTION_IFAGC). */
        double ifagc = get_num(line, "ifagc", -1);
        if (ifagc >= 0) prof_in.EnableIFAGC = ifagc > 0;
        if (debug)
            fprintf(stderr, "config in: ifagc=%u gainStrategy=%d detector=%d traceDetector=%d spur=%d window=%d "
                    "swtMode=%d tracePoints=%u ptsStrategy=%d traceType=%d lo=%d\n",
                    prof_in.EnableIFAGC, (int)prof_in.GainStrategy, (int)prof_in.Detector,
                    (int)prof_in.TraceDetector, (int)prof_in.SpurRejection, (int)prof_in.Window,
                    (int)prof_in.SweepTimeMode, prof_in.TracePoints, (int)prof_in.TracePointsStrategy,
                    (int)prof_in.TraceType, (int)prof_in.LOOptimization);
        int st = SWP_Configuration(&dev, &prof_in, &prof_out, &ti);
        first_status = st;
        if (st != 0) {
            /* fReqon's experience: a profile the SDK refuses with AlignToStart
               on some builds is accepted from a fresh default profile */
            SWP_Profile_TypeDef keep = prof_in;
            SWP_ProfileDeInit(&dev, &prof_in);
            prof_in.StartFreq_Hz = keep.StartFreq_Hz;
            prof_in.StopFreq_Hz = keep.StopFreq_Hz;
            prof_in.RBWMode = keep.RBWMode;
            prof_in.RBW_Hz = keep.RBW_Hz;
            prof_in.TraceAlign = AlignToStart;
            st = SWP_Configuration(&dev, &prof_in, &prof_out, &ti);
            fallback = true;
        }
        if (st != 0) {
            char msg[96];
            snprintf(msg, sizeof msg, "SWP_Configuration returned %d", st);
            reply_err(id, st, msg);
            configured = false;
            return;
        }
    }
    /* the SDK may have narrowed the range to what the hardware covers */
    if (prof_out.StartFreq_Hz > start) start = prof_out.StartFreq_Hz;
    if (prof_out.StopFreq_Hz > 0 && prof_out.StopFreq_Hz < stop) stop = prof_out.StopFreq_Hz;
    user_start = start;
    user_stop = stop;
    out_points = points;
    out_pwr = realloc(out_pwr, sizeof(float) * points);
    ensure_native(ti.FullsweepTracePoints > ti.PartialsweepTracePoints * ti.TotalHops
                      ? ti.FullsweepTracePoints
                      : ti.PartialsweepTracePoints * ti.TotalHops);
    have_prev = false;
    configured = true;
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"startHz\":%.3f,\"stopHz\":%.3f,\"pointCount\":%d,"
           "\"rbwHz\":%.3f,\"vbwHz\":%.3f,\"refLevelDbm\":%.2f,\"atten\":%d,\"nativePoints\":%d,"
           "\"hops\":%d,\"partialPoints\":%d,\"userStartIndex\":%u,\"userStopIndex\":%u,"
           "\"binHz\":%.3f,\"firstHz\":%.3f,\"minSweepTimeS\":%.4f,\"preamp\":%d,\"detector\":%d,"
           "\"spur\":%d,\"fallback\":%s,\"firstStatus\":%d,\"ifagc\":%d}}\n",
           id, user_start, user_stop, out_points, prof_out.RBW_Hz, prof_out.VBW_Hz,
           prof_out.RefLevel_dBm, (int)prof_out.Atten, ti.FullsweepTracePoints, ti.TotalHops,
           ti.PartialsweepTracePoints, ti.UserStartIndex, ti.UserStopIndex, ti.TraceBinBW_Hz,
           ti.StartFreq_Hz, ti.EstimateMinSweepTime, (int)prof_out.Preamplifier, (int)prof_out.Detector,
           (int)prof_out.SpurRejection, fallback ? "true" : "false", first_status, (int)prof_out.EnableIFAGC);
    fflush(stdout);
}

/* Native trace -> SoundBase's grid. Each native point goes to the output bin
   nearest its frequency (half a step either side) and each bin keeps the
   strongest, so a narrow carrier survives decimation. Points are binned one by
   one, so their order does not matter, and non-finite ones are skipped. Only a
   bin no point landed in (fewer native points than output points, or a hole)
   is interpolated, between its nearest filled neighbours. */
static int empty_bins; /* output bins no native point landed in, last sweep */

static void resample(const double *f, const float *p, int lo, int hi) {
    int n = out_points;
    empty_bins = 0;
    double step = (user_stop - user_start) / (n - 1);
    for (int k = 0; k < n; k++) out_pwr[k] = -INFINITY;
    for (int i = lo; i <= hi; i++) {
        if (!isfinite(p[i]) || !isfinite(f[i])) continue;
        double x = (f[i] - user_start) / step + 0.5;
        if (x < 0) continue;
        int k = (int)x;
        if (k >= n) continue;
        if (p[i] > out_pwr[k]) out_pwr[k] = p[i];
    }
    for (int k = 0; k < n; k++) if (out_pwr[k] == -INFINITY) empty_bins++;
    int prev = -1;
    for (int k = 0; k <= n; k++) {
        if (k < n && out_pwr[k] == -INFINITY) continue;
        /* fill the gap (prev, k) */
        for (int g = prev + 1; g < k; g++) {
            if (prev < 0 && k >= n) out_pwr[g] = -120;
            else if (prev < 0) out_pwr[g] = out_pwr[k];
            else if (k >= n) out_pwr[g] = out_pwr[prev];
            else out_pwr[g] = out_pwr[prev] + (out_pwr[k] - out_pwr[prev]) * (float)(g - prev) / (float)(k - prev);
        }
        prev = k;
    }
}

static float mock_gauss(double f, double c, double w, double h) {
    double x = (f - c) / w;
    return (float)(h * exp(-x * x));
}

static void op_sweep(long id) {
    if (!configured) {
        reply_err(id, -1, "not configured");
        return;
    }
    int N = ti.FullsweepTracePoints, P = ti.PartialsweepTracePoints;
    int lo, hi, ok_hops = 0, last_err = 0;
    int rej_index = 0, rej_dup = 0, rej_freq = 0, missing = 0;
    int gain_min = 1 << 30, gain_max = -1;
    bool overflow = false;
    MeasAuxInfo_TypeDef aux;
    memset(&aux, 0, sizeof aux);

    if (mock) {
        /* a noise floor, two carriers, a transient every seventh sweep */
        double span = user_stop - user_start;
        mock_sweeps++;
        for (int i = 0; i < N; i++) {
            double f = user_start + i * span / (N - 1);
            nat_freq[i] = f;
            nat_pwr[i] = -100 + (float)(rand() % 400) / 100 - 2 +
                         mock_gauss(f, user_start + span * 0.33, span * 0.004, 45) +
                         mock_gauss(f, user_start + span * 0.66, span * 0.002, 30) +
                         (mock_sweeps % 7 == 0 ? mock_gauss(f, user_start + span * 0.5, span * 0.001, 50) : 0);
        }
        struct timespec d = {0, 20 * 1000 * 1000};
        nanosleep(&d, NULL);
        lo = 0, hi = N - 1, ok_hops = 1;
        aux.Temperature = 4210;
    } else {
        /* Each hop is read into a scratch buffer far larger than the SDK says
           it needs (as fReqon does), then placed by the hop index it reports. */
        int hop = 0, frame = 0;
        int cap = nat_cap, T = ti.TotalHops;
        /* With spur rejection on, the SDK also hands out frames whose hop index
           is past TotalHops, at unrelated frequencies (88-108 MHz, Standard:
           hop 1 at 134 MHz, every other read). They are not part of the trace:
           read until each hop 0..T-1 has arrived once and skip the rest. A hop
           whose first frequency is not where the trace geometry puts it is
           skipped too. */
        static unsigned char *seen;
        static int seen_cap;
        if (seen_cap < T) {
            seen = realloc(seen, T);
            seen_cap = T;
        }
        memset(seen, 0, T);
        int max_reads = 4 * T + 8;
        for (int r = 0; r < max_reads && ok_hops < T; r++) {
            int st = SWP_GetPartialSweep(&dev, hop_freq, hop_pwr, &hop, &frame, &aux);
            if (debug)
                fprintf(stderr, "hop: r=%d st=%d hop=%d frame=%d f0=%.0f\n", r, st, hop, frame, hop_freq[0]);
            /* -12: IF overflow, a warning; the data is still a sweep */
            if (st != 0 && st != APIRETVAL_WARNING_IFOverflow) {
                last_err = st;
                if (r >= T) break; /* failing reads: do not spin */
                continue;
            }
            if (hop < 0 || hop >= T) { rej_index++; continue; }
            if (seen[hop]) { rej_dup++; continue; }
            double expect = ti.StartFreq_Hz + (double)hop * P * ti.TraceBinBW_Hz;
            if (ti.TraceBinBW_Hz > 0 && fabs(hop_freq[0] - expect) > 2 * ti.TraceBinBW_Hz) { rej_freq++; continue; }
            if (st != 0) overflow = true;
            if ((int)aux.GainPattern < gain_min) gain_min = aux.GainPattern;
            if ((int)aux.GainPattern > gain_max) gain_max = aux.GainPattern;
            int at = hop * P, n = P < HOP_SCRATCH ? P : HOP_SCRATCH;
            if (at + n > cap) n = cap - at;
            if (n > 0) {
                memcpy(nat_freq + at, hop_freq, sizeof(double) * n);
                memcpy(nat_pwr + at, hop_pwr, sizeof(float) * n);
            }
            seen[hop] = 1;
            ok_hops++;
        }
        /* Hop h fills [h*P, h*P+P); the user's span runs from UserStartIndex in
           the first hop to UserStopIndex in the last, so the full trace is
           (hops-1)*P + UserStopIndex + 1 points. (htraapi-macos's swp_test
           uses (N-P)+UserStopIndex, which goes negative for a single hop
           whose partial trace is longer than the full one, e.g. 88-108 MHz.) */
        lo = (int)ti.UserStartIndex;
        hi = (ti.TotalHops - 1) * P + (int)ti.UserStopIndex;
        if (hi > nat_cap - 1) hi = nat_cap - 1;
        if (hi > N - 1 && N > 0) hi = N - 1;
        if (lo < 0 || lo > hi) lo = 0;
        if (hi < lo) {
            reply_err(id, -1, "empty trace from the SDK");
            return;
        }
        /* A hop that did not arrive must not keep what its slot last held (an
           earlier sweep, perhaps at other settings and frequencies): it takes
           the previous sweep's levels at these settings, or is left empty and
           interpolated over. */
        for (int h = 0; h < T; h++) {
            if (seen[h]) continue;
            missing++;
            int at = h * P, end = at + P;
            if (end > cap) end = cap;
            for (int i = at; i < end; i++) nat_pwr[i] = have_prev ? prev_pwr[i] : NAN;
        }
        /* The frequency axis is the trace geometry, not whatever the buffer
           holds (fReqon does the same). */
        if (ti.TraceBinBW_Hz > 0)
            for (int i = lo; i <= hi; i++) nat_freq[i] = ti.StartFreq_Hz + (double)i * ti.TraceBinBW_Hz;
    }
    /* fReqon accepts a sweep with at most one hop missing, patched from the
       previous sweep; more than that is not a sweep */
    if (ok_hops < (ti.TotalHops > 1 ? ti.TotalHops - 1 : 1)) {
        char msg[96];
        snprintf(msg, sizeof msg, "sweep failed: %d of %d hops, last status %d", ok_hops, ti.TotalHops,
                 last_err);
        reply_err(id, last_err ? last_err : -1, msg);
        return;
    }
    /* unpopulated or non-finite points take the previous sweep's value */
    for (int i = lo; i <= hi; i++) {
        if (!isfinite(nat_pwr[i]) || (nat_pwr[i] == 0 && ((i > lo && nat_pwr[i - 1] == 0) ||
                                                           (i < hi && nat_pwr[i + 1] == 0))))
            nat_pwr[i] = have_prev ? prev_pwr[i] : NAN;
    }
    memcpy(prev_pwr + lo, nat_pwr + lo, sizeof(float) * (hi - lo + 1));
    have_prev = true;
    if (aux.Temperature) last_temp = aux.Temperature;

    if (debug)
        fprintf(stderr, "sweep: N=%d P=%d hops=%d ok=%d missing=%d rejected index/dup/freq=%d/%d/%d gain=%d..%d "
                "ifagc=%.1f lo=%d hi=%d f[lo]=%.0f f[hi]=%.0f p[lo]=%.2f p[mid]=%.2f p[hi]=%.2f\n",
                N, P, ti.TotalHops, ok_hops, missing, rej_index, rej_dup, rej_freq, gain_min, gain_max,
                aux.IFAGCGain, lo, hi, nat_freq[lo], nat_freq[hi], nat_pwr[lo], nat_pwr[(lo + hi) / 2], nat_pwr[hi]);
    resample(nat_freq, nat_pwr, lo, hi);
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"overflow\":%s,\"temperatureC\":%.2f,\"missingHops\":%d,"
           "\"rejectedFrames\":%d,\"rejectedFreq\":%d,\"gainMin\":%d,\"gainMax\":%d,\"ifagcDb\":%.2f,\"emptyBins\":%d,\"amps\":", id,
           overflow ? "true" : "false", last_temp / 100.0, missing, rej_index + rej_dup + rej_freq, rej_freq,
           gain_max < 0 ? 0 : gain_min, gain_max < 0 ? 0 : gain_max, aux.IFAGCGain, empty_bins);
    print_amps(out_pwr, out_points);
    printf("}}\n");
    fflush(stdout);
}

static void op_status(long id) {
    if (!is_open) {
        reply_err(id, -1, "not open");
        return;
    }
    if (mock) {
        printf("{\"id\":%ld,\"ok\":true,\"result\":{\"temperatureC\":42.1}}\n", id);
        fflush(stdout);
        return;
    }
    DeviceState_TypeDef s;
    memset(&s, 0, sizeof s);
    int st = Device_QueryDeviceState_Realtime(&dev, &s);
    if (st != 0) {
        char msg[96];
        snprintf(msg, sizeof msg, "Device_QueryDeviceState_Realtime returned %d", st);
        reply_err(id, st, msg);
        return;
    }
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"temperatureC\":%.2f}}\n", id, s.Temperature / 100.0);
    fflush(stdout);
}

static void close_device(void) {
    if (is_open && !mock) Device_Close(&dev);
    is_open = false;
    configured = false;
}

int main(void) {
    mock = getenv("HAROGIC_WORKER_MOCK") && *getenv("HAROGIC_WORKER_MOCK") == '1';
    debug = getenv("HAROGIC_WORKER_DEBUG") && *getenv("HAROGIC_WORKER_DEBUG") == '1';
    setvbuf(stdout, NULL, _IOFBF, 1 << 16);

    size_t cap = 0;
    char *line = NULL;
    ssize_t len;
    while ((len = getline(&line, &cap, stdin)) > 0) {
        long id = (long)get_num(line, "id", 0);
        char op[16] = "";
        get_str(line, "op", op, sizeof op);
        if (!strcmp(op, "hello")) op_hello(id);
        else if (!strcmp(op, "open")) op_open(id, line);
        else if (!strcmp(op, "config")) op_config(id, line);
        else if (!strcmp(op, "sweep")) op_sweep(id);
        else if (!strcmp(op, "status")) op_status(id);
        else if (!strcmp(op, "close")) {
            close_device();
            printf("{\"id\":%ld,\"ok\":true,\"result\":{}}\n", id);
            fflush(stdout);
            break;
        } else {
            reply_err(id, -1, "unknown op");
        }
    }
    close_device();
    return 0;
}

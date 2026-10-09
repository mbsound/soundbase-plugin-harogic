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
static bool is_open, mock;
static uint16_t model;

static SWP_Profile_TypeDef prof_in, prof_out;
static SWP_TraceInfo_TypeDef ti;
static bool configured;
static double user_start, user_stop; /* the grid SoundBase draws */
static int out_points;

static double *nat_freq;
static float *nat_pwr, *prev_pwr, *out_pwr;
static int nat_cap;
static bool have_prev;

static int16_t last_temp;
static int mock_sweeps;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static void ensure_native(int n) {
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
        st = Device_Open(&dev, (int)get_num(line, "index", 0), &boot, &info);
        if (st < 0) {
            char msg[160];
            snprintf(msg, sizeof msg, "Device_Open returned %d (firmware 0x%x)", st,
                     (unsigned)info.DeviceInfo.MFWVersion);
            reply_err(id, st, msg);
            return;
        }
    }
    is_open = true;
    model = info.DeviceInfo.Model;
    configured = false;
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"status\":%d,\"model\":%u,\"uid\":\"%016llx\","
           "\"hardware\":%u,\"mcuFirmware\":%u,\"fpgaFirmware\":%u,\"busSpeed\":%u,\"api\":%u,"
           "\"sdk\":\"%s\",\"openSeconds\":%.2f,\"warnings\":[",
           id, st, model, (unsigned long long)info.DeviceInfo.DeviceUID,
           info.DeviceInfo.HardwareVersion, (unsigned)info.DeviceInfo.MFWVersion,
           (unsigned)info.DeviceInfo.FFWVersion, (unsigned)info.BusSpeed,
           (unsigned)Get_APIVersion(), SDK_LABEL, now_s() - t0);
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
        int st = SWP_Configuration(&dev, &prof_in, &prof_out, &ti);
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
           "\"hops\":%d,\"minSweepTimeS\":%.4f}}\n",
           id, user_start, user_stop, out_points, prof_out.RBW_Hz, prof_out.VBW_Hz,
           prof_out.RefLevel_dBm, (int)prof_out.Atten, ti.FullsweepTracePoints, ti.TotalHops,
           ti.EstimateMinSweepTime);
    fflush(stdout);
}

/* Native trace -> SoundBase's grid. Each output point covers half a step
   either side of its frequency and takes the strongest native point in it, so
   a narrow carrier survives decimation. A bin with no native point in it
   (fewer native points than output points) is interpolated. */
static void resample(const double *f, const float *p, int lo, int hi) {
    int n = out_points;
    double step = (user_stop - user_start) / (n - 1);
    int j = lo;
    for (int k = 0; k < n; k++) {
        double fc = user_start + k * step, a = fc - step / 2, b = fc + step / 2;
        while (j <= hi && f[j] < a) j++;
        float best = -INFINITY;
        int m = j;
        while (m <= hi && f[m] < b) {
            if (p[m] > best) best = p[m];
            m++;
        }
        if (best == -INFINITY) {
            int r = j > hi ? hi : j, l = r > lo ? r - 1 : r;
            if (r == l || f[r] == f[l]) best = p[r];
            else {
                double t = (fc - f[l]) / (f[r] - f[l]);
                if (t < 0) t = 0;
                if (t > 1) t = 1;
                best = (float)(p[l] + t * (p[r] - p[l]));
            }
        }
        out_pwr[k] = best;
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
        int hop = 0, frame = 0;
        for (int i = 0; i < ti.TotalHops; i++) {
            int st = SWP_GetPartialSweep(&dev, nat_freq + i * P, nat_pwr + i * P, &hop, &frame, &aux);
            /* -12: IF overflow, a warning; the data is still a sweep */
            if (st == 0 || st == APIRETVAL_WARNING_IFOverflow) {
                if (st != 0) overflow = true;
                if (hop != i && hop >= 0 && hop < ti.TotalHops) {
                    memmove(nat_freq + hop * P, nat_freq + i * P, sizeof(double) * P);
                    memmove(nat_pwr + hop * P, nat_pwr + i * P, sizeof(float) * P);
                }
                ok_hops++;
            } else {
                last_err = st;
            }
        }
        lo = (int)ti.UserStartIndex;
        hi = (N - P) + (int)ti.UserStopIndex;
        if (hi >= N) hi = N - 1;
        if (lo < 0 || lo > hi) lo = 0;
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
            nat_pwr[i] = have_prev ? prev_pwr[i] : -120;
    }
    memcpy(prev_pwr + lo, nat_pwr + lo, sizeof(float) * (hi - lo + 1));
    have_prev = true;
    if (aux.Temperature) last_temp = aux.Temperature;

    resample(nat_freq, nat_pwr, lo, hi);
    printf("{\"id\":%ld,\"ok\":true,\"result\":{\"overflow\":%s,\"temperatureC\":%.2f,\"amps\":", id,
           overflow ? "true" : "false", last_temp / 100.0);
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

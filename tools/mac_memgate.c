// mac_memgate: run one job on a Mac under hard memory limits (Core ML work on a 16 GB Mac, BACKLOG row 24).
//
//   cc -O2 -o mac_memgate tools/mac_memgate.c
//   mac_memgate [--fp-gb 9] [--swap-mb 512] [--pressure 2] [--min-avail-gb 8] [--log FILE] -- CMD ARGS...
//
// Every 0.25 s it reads the job's memory as macOS counts it, phys_footprint (compressed and swapped pages included;
// RSS leaves them out, which is how a 2026-10-26 run swapped 22.8 GB under an RSS watchdog), summed over the job's
// process tree, the system's swap use and its memory pressure level. Memory the job makes system services use (Core
// ML's Neural Engine compiler, ANECompilerService, runs as root: its footprint can't be read without root) shows only
// in swap and pressure. It SIGKILLs the job (its process group and every process in its tree) when the footprint
// passes --fp-gb, swap use grows more than --swap-mb over its value at the start, or pressure reaches --pressure
// (kern.memorystatus_vm_pressure_level: 2 warn, the default; 4 critical). The job doesn't start while pressure isn't
// normal or less than --min-avail-gb is available (kern.memorystatus_level, the "free percentage" memory_pressure
// prints). One line per second to --log
// (stderr without), every kill with its reading; the last line is the peaks and the verdict.
// Exit: the job's own status; 137 when killed here; 75 when it didn't start.
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAXP 8192
#define MB (1024.0 * 1024.0)

static int sys_int(const char *name) {
  int v = 0;
  size_t n = sizeof v;
  return sysctlbyname(name, &v, &n, NULL, 0) == 0 ? v : -1;
}

static double swap_used_mb(void) {
  struct xsw_usage s;
  size_t n = sizeof s;
  return sysctlbyname("vm.swapusage", &s, &n, NULL, 0) == 0 ? s.xsu_used / MB : -1;
}

static double avail_mb(void) {
  unsigned long long mem = 0;
  size_t n = sizeof mem;
  sysctlbyname("hw.memsize", &mem, &n, NULL, 0);
  return mem / MB * sys_int("kern.memorystatus_level") / 100.0;
}

static unsigned long long footprint(pid_t p) {
  struct rusage_info_v4 ri;
  return proc_pid_rusage(p, RUSAGE_INFO_V4, (rusage_info_t *)&ri) == 0 ? ri.ri_phys_footprint : 0;
}

static pid_t pids[MAXP], tree[MAXP];
static int ntree;

// the job's tree (root and every descendant, by parent pid) and its footprint in MB
static double sample(pid_t root) {
  int n = proc_listallpids(pids, sizeof pids);
  pid_t ppid[MAXP];
  // loop: SERIAL-REQUIRED — one pass over the process table per sample [bounded: MAXP]
  for (int i = 0; i < n; i++) {
    struct proc_bsdshortinfo si;
    ppid[i] = proc_pidinfo(pids[i], PROC_PIDT_SHORTBSDINFO, 0, &si, sizeof si) == sizeof si ? (pid_t)si.pbsi_ppid : 0;
  }
  ntree = 0;
  tree[ntree++] = root;
  // loop: SERIAL-REQUIRED — breadth-first over the tree [bounded: MAXP]
  for (int k = 0; k < ntree; k++)
    // loop: NOT-WORTH — the process table for each tree member (a job has a handful of processes)
    for (int i = 0; i < n && ntree < MAXP; i++)
      if (ppid[i] == tree[k] && pids[i] != root) tree[ntree++] = pids[i];
  unsigned long long j = 0;
  // loop: NOT-WORTH — the tree's few processes
  for (int k = 0; k < ntree; k++) j += footprint(tree[k]);
  return j / MB;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
  double fp_gb = 9, swap_lim = 512, min_avail_gb = 8;
  int plim = 2;
  const char *logpath = NULL;
  int i = 1;
  // loop: NOT-WORTH — the command line's few options
  for (; i < argc && strcmp(argv[i], "--") != 0; i += 2) {
    if (i + 1 >= argc) break;
    if (!strcmp(argv[i], "--fp-gb")) fp_gb = atof(argv[i + 1]);
    else if (!strcmp(argv[i], "--swap-mb")) swap_lim = atof(argv[i + 1]);
    else if (!strcmp(argv[i], "--pressure")) plim = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "--min-avail-gb")) min_avail_gb = atof(argv[i + 1]);
    else if (!strcmp(argv[i], "--log")) logpath = argv[i + 1];
    else { fprintf(stderr, "mac_memgate: unknown option %s\n", argv[i]); return 2; }
  }
  if (i >= argc - 1) { fprintf(stderr, "mac_memgate: usage: mac_memgate [options] -- CMD ARGS...\n"); return 2; }
  FILE *log = logpath ? fopen(logpath, "a") : stderr;
  if (!log) { perror(logpath); return 2; }
  setvbuf(log, NULL, _IOLBF, 0);

  int lvl = sys_int("kern.memorystatus_vm_pressure_level");
  double av = avail_mb(), swap0 = swap_used_mb();
  if (lvl != 1 || av < min_avail_gb * 1024) {
    fprintf(log, "NOT STARTED: pressure level %d (1 = normal), available %.0f MB < %.0f MB or pressure not normal\n", lvl, av, min_avail_gb * 1024);
    return 75;
  }
  fprintf(log, "start: available %.0f MB, swap used %.0f MB, limits footprint %.1f GB, swap growth %.0f MB, pressure level %d\n", av, swap0, fp_gb, swap_lim, plim);

  pid_t child = fork();
  if (child < 0) { perror("fork"); return 2; }
  if (child == 0) {
    setpgid(0, 0);
    execvp(argv[i + 1], argv + i + 1);
    perror(argv[i + 1]);
    _exit(127);
  }
  setpgid(child, child);

  double t0 = now(), last = -1, peak = 0, peak_swap = 0;
  int peak_lvl = 1, status = 0, killed = 0;
  char why[256] = "";
  // loop: SERIAL-REQUIRED — one sample every 0.25 s while the job lives [bounded: the job's life; the kills below]
  for (;;) {
    pid_t w = waitpid(child, &status, WNOHANG);  // loop: NOT-WORTH — WNOHANG, never blocks [bounded: returns at once]
    if (w == child) break;
    double job = sample(child);
    double sw = swap_used_mb() - swap0;
    lvl = sys_int("kern.memorystatus_vm_pressure_level");
    if (job > peak) peak = job;
    if (sw > peak_swap) peak_swap = sw;
    if (lvl > peak_lvl) peak_lvl = lvl;
    double t = now() - t0;
    if (!killed) {
      if (job > fp_gb * 1024) snprintf(why, sizeof why, "footprint %.0f MB > %.1f GB", job, fp_gb);
      else if (sw > swap_lim) snprintf(why, sizeof why, "swap grew %.0f MB > %.0f MB", sw, swap_lim);
      else if (lvl >= plim) snprintf(why, sizeof why, "memory pressure level %d (%s)", lvl, lvl >= 4 ? "critical" : "warn");
      if (why[0]) {
        kill(-child, SIGKILL);
        // loop: NOT-WORTH — the tree's processes, once
        for (int k = 0; k < ntree; k++) kill(tree[k], SIGKILL);
        killed = 1;
        fprintf(log, "KILLED at %.2f s: %s; footprint %.0f MB, swap %+.0f MB, pressure %d, available %.0f MB, %d processes\n",
                t, why, job, sw, lvl, avail_mb(), ntree);
      }
    }
    if (t - last >= 1.0) {
      fprintf(log, "%7.2f s  footprint %6.0f MB  swap %+6.0f MB  pressure %d  available %6.0f MB  procs %d\n", t, job, sw, lvl, avail_mb(), ntree);
      last = t;
    }
    usleep(250000);  // loop: SERIAL-REQUIRED — the 0.25 s sampling period
  }
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  fprintf(log, "end after %.1f s: peak footprint %.0f MB, peak swap growth %.0f MB, worst pressure %d; %s\n",
          now() - t0, peak, peak_swap, peak_lvl, killed ? why : "finished");
  fprintf(log, "verdict: %s (exit %d)\n", killed ? "KILLED" : "finished", killed ? 137 : code);
  return killed ? 137 : code;
}

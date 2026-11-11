#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "protocol.h"

#define MAX_CONNECTIONS 256
#define MAX_SIGNAL 64

enum stage { HEAD, BODY, RUNNING };

struct connection {
  int fd;
  int fds[FORGE_REQUEST_FDS];
  int received;
  uint32_t length;
  size_t got;
  char *body;
  pid_t pid;
  enum stage stage;
  int used;
};

static struct connection connections[MAX_CONNECTIONS];
static struct rlimit original_files;
static const char **withheld;
static int withheld_count;
extern char **environ;

static void release(struct connection *c) {
  for (int i = 0; i < c->received; i++) close(c->fds[i]);
  if (c->fd >= 0) close(c->fd);
  free(c->body);
  memset(c, 0, sizeof *c);
  c->fd = -1;
}

static void refuse(struct connection *c, const char *why) {
  int32_t status = FORGE_REFUSED_STATUS;
  fprintf(stderr, "forge-broker: refused a request: %s\n", why);
  send(c->fd, &status, sizeof status, MSG_NOSIGNAL);
  release(c);
}

static const char *const LOADER_AND_SHELL[] = {"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "GLIBC_TUNABLES", "IFS"};

static int is_withheld(const char *entry) {
  const char *eq = strchr(entry, '=');
  size_t n = eq == NULL ? strlen(entry) : (size_t)(eq - entry);
  if (strncmp(entry, "LD_", 3) == 0 || strncmp(entry, "BASH_FUNC_", 10) == 0) return 1;
  for (size_t i = 0; i < sizeof LOADER_AND_SHELL / sizeof *LOADER_AND_SHELL; i++)
    if (strlen(LOADER_AND_SHELL[i]) == n && strncmp(LOADER_AND_SHELL[i], entry, n) == 0) return 1;
  for (int i = 0; i < withheld_count; i++)
    if (strlen(withheld[i]) == n && strncmp(withheld[i], entry, n) == 0) return 1;
  return 0;
}

static int same_name(const char *a, const char *b) {
  const char *ea = strchr(a, '=');
  const char *eb = strchr(b, '=');
  if (ea == NULL || eb == NULL) return 0;
  return ea - a == eb - b && strncmp(a, b, (size_t)(ea - a)) == 0;
}

static const char *next_string(const char **cursor, const char *end) {
  const char *start = *cursor;
  const char *stop = memchr(start, 0, (size_t)(end - start));
  if (stop == NULL) return NULL;
  *cursor = stop + 1;
  return start;
}

static int count_of(const char **cursor, const char *end) {
  const char *text = next_string(cursor, end);
  if (text == NULL) return -1;
  char *rest;
  long value = strtol(text, &rest, 10);
  if (*text == 0 || *rest != 0 || value < 0 || value > 1000000) return -1;
  return (int)value;
}

static char *value_of(char **env, const char *name) {
  size_t n = strlen(name);
  for (; *env != NULL; env++)
    if (strncmp(*env, name, n) == 0 && (*env)[n] == '=') return *env + n + 1;
  return NULL;
}

static void locate_shell(char **env, char *out, size_t size) {
  const char *path = value_of(env, "PATH");
  if (path != NULL) {
    const char *p = path;
    while (*p != 0 || p == path) {
      const char *colon = strchr(p, ':');
      size_t n = colon == NULL ? strlen(p) : (size_t)(colon - p);
      if (n > 0 && n + 6 < size) {
        memcpy(out, p, n);
        strcpy(out + n, "/bash");
        if (access(out, X_OK) == 0) return;
      }
      if (colon == NULL) break;
      p = colon + 1;
    }
  }
  snprintf(out, size, "/bin/sh");
}

static void start(struct connection *c) {
  const char *cursor = c->body;
  const char *end = c->body + c->length;
  const char *cwd = next_string(&cursor, end);
  int argc = count_of(&cursor, end);
  if (cwd == NULL || argc < 0) return refuse(c, "malformed request");
  const char **args = calloc((size_t)argc + 2, sizeof *args);
  if (args == NULL) return refuse(c, "out of memory");
  args[0] = "bash";
  for (int i = 0; i < argc; i++) {
    args[i + 1] = next_string(&cursor, end);
    if (args[i + 1] == NULL) {
      free(args);
      return refuse(c, "malformed request");
    }
  }
  int envc = count_of(&cursor, end);
  if (envc < 0) {
    free(args);
    return refuse(c, "malformed request");
  }
  int base = 0;
  while (environ[base] != NULL) base++;
  char **env = calloc((size_t)base + (size_t)envc + 1, sizeof *env);
  if (env == NULL) {
    free(args);
    return refuse(c, "out of memory");
  }
  int n = 0;
  for (int i = 0; i < envc; i++) {
    const char *entry = next_string(&cursor, end);
    if (entry == NULL) {
      free(args);
      free(env);
      return refuse(c, "malformed request");
    }
    if (strchr(entry, '=') == NULL || is_withheld(entry)) continue;
    int shadowed = 0;
    for (int j = 0; j < base; j++)
      if (same_name(environ[j], entry)) shadowed = 1;
    if (!shadowed) env[n++] = (char *)entry;
  }
  for (int j = 0; j < base; j++) env[n++] = environ[j];
  env[n] = NULL;
  char shell[PATH_MAX];
  locate_shell(env, shell, sizeof shell);
  pid_t pid = fork();
  if (pid < 0) {
    free(args);
    free(env);
    return refuse(c, "fork failed");
  }
  if (pid == 0) {
    setrlimit(RLIMIT_NOFILE, &original_files);
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    setpgid(0, 0);
    int staged[FORGE_REQUEST_FDS];
    for (int i = 0; i < FORGE_REQUEST_FDS; i++) {
      staged[i] = fcntl(c->fds[i], F_DUPFD, 10);
      if (staged[i] < 0) _exit(FORGE_REFUSED_STATUS);
    }
    for (int i = 0; i < FORGE_REQUEST_FDS; i++) {
      if (dup2(staged[i], i) < 0) _exit(FORGE_REFUSED_STATUS);
    }
    for (int i = 0; i < FORGE_REQUEST_FDS; i++) {
      close(staged[i]);
      if (c->fds[i] >= FORGE_REQUEST_FDS) close(c->fds[i]);
    }
    if (chdir(cwd) < 0) {
      dprintf(2, "forge-broker: cannot enter %s: %s\n", cwd, strerror(errno));
      _exit(126);
    }
    execve(shell, (char *const *)args, env);
    dprintf(2, "forge-broker: cannot run %s: %s\n", shell, strerror(errno));
    _exit(127);
  }
  setpgid(pid, pid);
  free(args);
  free(env);
  for (int i = 0; i < c->received; i++) close(c->fds[i]);
  c->received = 0;
  free(c->body);
  c->body = NULL;
  c->pid = pid;
  c->stage = RUNNING;
}

static void take_head(struct connection *c) {
  char data[sizeof(uint32_t)];
  union {
    struct cmsghdr align;
    char space[CMSG_SPACE(sizeof(int) * FORGE_REQUEST_FDS)];
  } control = {0};
  struct iovec iov = {data, sizeof data};
  struct msghdr msg = {0};
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.space;
  msg.msg_controllen = sizeof control.space;
  ssize_t got = recvmsg(c->fd, &msg, MSG_CMSG_CLOEXEC);
  if (got < 0 && (errno == EAGAIN || errno == EINTR)) return;
  if (got < 0) return release(c);
  for (struct cmsghdr *h = CMSG_FIRSTHDR(&msg); h != NULL; h = CMSG_NXTHDR(&msg, h)) {
    if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS) continue;
    int count = (int)((h->cmsg_len - CMSG_LEN(0)) / sizeof(int));
    int *sent = (int *)CMSG_DATA(h);
    for (int i = 0; i < count; i++) {
      if (c->received < FORGE_REQUEST_FDS) c->fds[c->received++] = sent[i];
      else close(sent[i]);
    }
  }
  if (got != (ssize_t)sizeof data || (msg.msg_flags & MSG_CTRUNC) != 0) return release(c);
  memcpy(&c->length, data, sizeof data);
  if (c->received != FORGE_REQUEST_FDS) return refuse(c, "expected three descriptors");
  if (c->length == 0 || c->length > FORGE_MAX_REQUEST) return refuse(c, "bad request length");
  c->body = malloc(c->length);
  if (c->body == NULL) return refuse(c, "out of memory");
  c->stage = BODY;
}

static void take_body(struct connection *c) {
  ssize_t got = read(c->fd, c->body + c->got, c->length - c->got);
  if (got < 0 && (errno == EAGAIN || errno == EINTR)) return;
  if (got <= 0) return release(c);
  c->got += (size_t)got;
  if (c->got == c->length) start(c);
}

static void take_signals(struct connection *c) {
  unsigned char data[64];
  ssize_t got = read(c->fd, data, sizeof data);
  if (got < 0 && (errno == EAGAIN || errno == EINTR)) return;
  if (got <= 0) {
    kill(-c->pid, SIGKILL);
    close(c->fd);
    c->fd = -1;
    return;
  }
  for (ssize_t i = 0; i < got; i++)
    if (data[i] >= 1 && data[i] <= MAX_SIGNAL) kill(-c->pid, data[i]);
}

static void reap(void) {
  int wait_status;
  pid_t pid;
  while ((pid = waitpid(-1, &wait_status, WNOHANG)) > 0) {
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
      struct connection *c = &connections[i];
      if (!c->used || c->stage != RUNNING || c->pid != pid) continue;
      int32_t status = WIFEXITED(wait_status) ? WEXITSTATUS(wait_status) : 128 + WTERMSIG(wait_status);
      if (c->fd >= 0) send(c->fd, &status, sizeof status, MSG_NOSIGNAL);
      release(c);
      break;
    }
  }
}

static int listen_on(const char *path) {
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  if (strlen(path) >= sizeof address.sun_path) {
    fprintf(stderr, "forge-broker: socket path too long\n");
    exit(2);
  }
  strcpy(address.sun_path, path);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    perror("forge-broker: socket");
    exit(2);
  }
  unlink(path);
  if (bind(fd, (struct sockaddr *)&address, sizeof address) < 0 || listen(fd, 128) < 0) {
    perror("forge-broker: listen");
    exit(2);
  }
  return fd;
}

static void prelisten(const char *path, char **command) {
  int fd = listen_on(path);
  if (fd != FORGE_LISTEN_FD) {
    if (dup2(fd, FORGE_LISTEN_FD) < 0) {
      perror("forge-broker: dup2");
      exit(2);
    }
    close(fd);
  }
  fcntl(FORGE_LISTEN_FD, F_SETFD, 0);
  execv(command[0], command);
  perror("forge-broker: exec");
  exit(2);
}

int main(int argc, char **argv) {
  withheld = calloc((size_t)argc, sizeof *withheld);
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--prelisten") == 0 && i + 3 < argc && strcmp(argv[i + 2], "--") == 0)
      prelisten(argv[i + 1], argv + i + 3);
    else if (strcmp(argv[i], "--withhold") == 0 && i + 1 < argc) withheld[withheld_count++] = argv[++i];
    else {
      fprintf(stderr, "usage: forge-broker [--withhold NAME]... | --prelisten PATH -- COMMAND...\n");
      return 2;
    }
  }
  for (int fd = 3; fd < 256; fd++)
    if (fd != FORGE_LISTEN_FD) close(fd);
  for (int i = 0; i < MAX_CONNECTIONS; i++) connections[i].fd = -1;
  sigset_t chld;
  sigemptyset(&chld);
  sigaddset(&chld, SIGCHLD);
  sigprocmask(SIG_BLOCK, &chld, NULL);
  int signals = signalfd(-1, &chld, SFD_CLOEXEC | SFD_NONBLOCK);
  if (signals < 0) {
    perror("forge-broker: signalfd");
    return 2;
  }
  struct rlimit files;
  if (getrlimit(RLIMIT_NOFILE, &original_files) == 0) {
    files = original_files;
    files.rlim_cur = files.rlim_max;
    setrlimit(RLIMIT_NOFILE, &files);
  }
  int listener = FORGE_LISTEN_FD;
  int listening = 0;
  socklen_t size = sizeof listening;
  if (getsockopt(listener, SOL_SOCKET, SO_ACCEPTCONN, &listening, &size) < 0 || !listening) {
    fprintf(stderr, "forge-broker: descriptor %d is not a listening socket\n", FORGE_LISTEN_FD);
    return 2;
  }
  fcntl(listener, F_SETFD, FD_CLOEXEC);
  if (write(1, "ready\n", 6) != 6) return 2;
  static struct pollfd polled[MAX_CONNECTIONS + 2];
  for (;;) {
    polled[0] = (struct pollfd){listener, POLLIN, 0};
    polled[1] = (struct pollfd){signals, POLLIN, 0};
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
      struct connection *c = &connections[i];
      polled[i + 2] = (struct pollfd){c->used ? c->fd : -1, POLLIN, 0};
    }
    if (poll(polled, MAX_CONNECTIONS + 2, -1) < 0) continue;
    if (polled[1].revents != 0) {
      struct signalfd_siginfo info;
      while (read(signals, &info, sizeof info) > 0) {
      }
    }
    reap();
    if (polled[0].revents != 0) {
      int fd = accept4(listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (fd >= 0) {
        int slot = 0;
        while (slot < MAX_CONNECTIONS && connections[slot].used) slot++;
        if (slot == MAX_CONNECTIONS) close(fd);
        else {
          connections[slot].used = 1;
          connections[slot].fd = fd;
          connections[slot].stage = HEAD;
        }
      }
    }
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
      struct connection *c = &connections[i];
      if (!c->used || c->fd < 0 || polled[i + 2].revents == 0) continue;
      if (c->stage == HEAD) take_head(c);
      else if (c->stage == BODY) take_body(c);
      else take_signals(c);
    }
  }
}

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "protocol.h"

#define CONNECT_ATTEMPTS 100
#define CONNECT_PAUSE_US 50000

extern char **environ;

static const int FORWARDED[] = {SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGWINCH};

static void fail(const char *why) {
  fprintf(stderr, "forge-shell: %s\n", why);
  exit(1);
}

static size_t append(char **buffer, size_t *size, size_t *used, const char *text) {
  size_t n = strlen(text) + 1;
  if (*used + n > *size) {
    while (*used + n > *size) *size *= 2;
    *buffer = realloc(*buffer, *size);
    if (*buffer == NULL) fail("out of memory");
  }
  memcpy(*buffer + *used, text, n);
  *used += n;
  return n;
}

static size_t count_of(char **list) {
  size_t n = 0;
  while (list[n] != NULL) n++;
  return n;
}

static char *encode(int count, char **arguments, size_t *length) {
  size_t size = 4096;
  size_t used = 0;
  char *buffer = malloc(size);
  char cwd[4096];
  char number[24];
  if (buffer == NULL) fail("out of memory");
  if (getcwd(cwd, sizeof cwd) == NULL) fail("cannot read the working directory");
  append(&buffer, &size, &used, cwd);
  snprintf(number, sizeof number, "%d", count);
  append(&buffer, &size, &used, number);
  for (int i = 0; i < count; i++) append(&buffer, &size, &used, arguments[i]);
  snprintf(number, sizeof number, "%zu", count_of(environ));
  append(&buffer, &size, &used, number);
  for (char **e = environ; *e != NULL; e++) append(&buffer, &size, &used, *e);
  *length = used;
  return buffer;
}

#ifndef FORGE_GIT_SHIM
static char **shell_arguments(int argc, char **argv, int *count) {
  int extra = argc >= 2 && argv[1][0] != '-' ? 1 : 0;
  char **arguments = calloc((size_t)argc + 1, sizeof *arguments);
  if (arguments == NULL) fail("out of memory");
  int n = 0;
  if (extra) arguments[n++] = "-c";
  for (int i = 1; i < argc; i++) arguments[n++] = argv[i];
  *count = n;
  return arguments;
}
#else
static char **git_arguments(int argc, char **argv, int *count) {
  char **arguments = calloc((size_t)argc + 3, sizeof *arguments);
  if (arguments == NULL) fail("out of memory");
  int n = 0;
  arguments[n++] = "-c";
  arguments[n++] = "exec git \"$@\"";
  arguments[n++] = "git";
  for (int i = 1; i < argc; i++) arguments[n++] = argv[i];
  *count = n;
  return arguments;
}
#endif

static void keep_stdio_open(void) {
  for (int fd = 0; fd < FORGE_REQUEST_FDS; fd++)
    if (fcntl(fd, F_GETFD) < 0 && errno == EBADF && open("/dev/null", O_RDWR) != fd) fail("cannot open standard descriptors");
}

static int connect_broker(void) {
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, FORGE_BROKER_SOCKET);
  for (int attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) fail("cannot create a socket");
    if (connect(fd, (struct sockaddr *)&address, sizeof address) == 0) return fd;
    close(fd);
    if (errno != ENOENT && errno != ECONNREFUSED) break;
    usleep(CONNECT_PAUSE_US);
  }
  fail("cannot reach the tools sandbox's command broker");
  return -1;
}

static void send_all(int fd, const char *data, size_t length) {
  while (length > 0) {
    ssize_t sent = send(fd, data, length, MSG_NOSIGNAL);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) fail("the tools sandbox's command broker went away");
    data += sent;
    length -= (size_t)sent;
  }
}

static void send_request(int fd, const char *body, size_t length) {
  uint32_t head = (uint32_t)length;
  union {
    struct cmsghdr align;
    char space[CMSG_SPACE(sizeof(int) * FORGE_REQUEST_FDS)];
  } control = {0};
  struct iovec iov = {&head, sizeof head};
  struct msghdr msg = {0};
  int fds[FORGE_REQUEST_FDS] = {0, 1, 2};
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = control.space;
  msg.msg_controllen = CMSG_SPACE(sizeof fds);
  struct cmsghdr *h = CMSG_FIRSTHDR(&msg);
  h->cmsg_level = SOL_SOCKET;
  h->cmsg_type = SCM_RIGHTS;
  h->cmsg_len = CMSG_LEN(sizeof fds);
  memcpy(CMSG_DATA(h), fds, sizeof fds);
  if (sendmsg(fd, &msg, MSG_NOSIGNAL) != (ssize_t)sizeof head) fail("cannot reach the tools sandbox's command broker");
  send_all(fd, body, length);
}

int main(int argc, char **argv) {
  keep_stdio_open();
#ifdef FORGE_GIT_SHIM
  int count;
  char **arguments = git_arguments(argc, argv, &count);
#else
  if (argc < 2) fail("usage: forge-shell -c COMMAND");
  int count;
  char **arguments = shell_arguments(argc, argv, &count);
#endif
  size_t length;
  char *body = encode(count, arguments, &length);
  free(arguments);
  int broker = connect_broker();
  sigset_t forwarded;
  sigemptyset(&forwarded);
  for (size_t i = 0; i < sizeof FORWARDED / sizeof *FORWARDED; i++) sigaddset(&forwarded, FORWARDED[i]);
  sigprocmask(SIG_BLOCK, &forwarded, NULL);
  int signals = signalfd(-1, &forwarded, SFD_CLOEXEC);
  if (signals < 0) fail("cannot watch signals");
  send_request(broker, body, length);
  free(body);
  struct pollfd polled[2] = {{broker, POLLIN, 0}, {signals, POLLIN, 0}};
  for (;;) {
    if (poll(polled, 2, -1) < 0) {
      if (errno == EINTR) continue;
      fail("cannot wait for the command");
    }
    if (polled[1].revents != 0) {
      struct signalfd_siginfo info;
      if (read(signals, &info, sizeof info) == (ssize_t)sizeof info) {
        unsigned char number = (unsigned char)info.ssi_signo;
        send(broker, &number, 1, MSG_NOSIGNAL);
      }
    }
    if (polled[0].revents != 0) {
      int32_t status;
      ssize_t got = read(broker, &status, sizeof status);
      if (got == (ssize_t)sizeof status) return status & 0xff;
      if (got < 0 && errno == EINTR) continue;
      fail("the tools sandbox's command broker went away");
    }
  }
}

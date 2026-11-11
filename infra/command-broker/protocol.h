#ifndef FORGE_PROTOCOL_H
#define FORGE_PROTOCOL_H

#include <stdint.h>

#ifndef FORGE_BROKER_SOCKET
#define FORGE_BROKER_SOCKET "/run/forge-tools/broker.sock"
#endif
#define FORGE_MAX_REQUEST (16u * 1024u * 1024u)
#define FORGE_REQUEST_FDS 3
#define FORGE_REFUSED_STATUS 125

#endif

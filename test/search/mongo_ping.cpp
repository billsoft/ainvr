// AINVR. Lightweight readiness command for the isolated loopback test database.
#include <mongoc/mongoc.h>
int main(int argc, char**) {
  if (argc != 1) return 64;
  mongoc_init();
  auto* client = mongoc_client_new("mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=200&connectTimeoutMS=200&socketTimeoutMS=200");
  if (!client) { mongoc_cleanup(); return 1; }
  bson_t command = BSON_INITIALIZER, reply;
  BSON_APPEND_INT32(&command, "ping", 1);
  bson_error_t error{};
  const bool ready = mongoc_client_command_simple(client, "admin", &command, nullptr, &reply, &error);
  bson_destroy(&reply); bson_destroy(&command);
  mongoc_client_destroy(client); mongoc_cleanup();
  return ready ? 0 : 1;
}

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "spool", worker = (
      compatibilityDate = "2025-11-17",
      modules = [(name = "worker.fixture.js", esModule = embed "../.wrangler/worker.fixture.js")],
      durableObjectStorage = (inMemory = void),
      durableObjectNamespaces = [
        (className = "TestedTenantRunner", uniqueKey = "spool-test-tenant", enableSql = true),
        (className = "GuestFixture", uniqueKey = "spool-test-guest", enableSql = true),
        (className = "BlobData", uniqueKey = "spool-test-blob", enableSql = true)
      ],
      bindings = [
        (name = "SPOOL_TOKEN", text = "token-only-used-by-the-local-workerd-test"),
        (name = "TENANTS", durableObjectNamespace = (className = "TestedTenantRunner")),
        (name = "GUESTS", durableObjectNamespace = (className = "GuestFixture")),
        (name = "BLOB_DATA", durableObjectNamespace = (className = "BlobData")),
        (name = "LAYERS", service = (name = "spool", entrypoint = "BlobBinding"))
      ]
    ))
  ]
);

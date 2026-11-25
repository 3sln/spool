(ns spool.tools
  (:require [babashka.fs :as fs]
            [babashka.process :refer [shell]]
            [cheshire.core :as json]
            [clojure.string :as str]))

(defn- env [key fallback]
  (or (System/getenv key) fallback))

(defn- output [& args]
  (str/trim (:out (apply shell {:out :string} args))))

(defn guest-bin []
  (env "SPOOL_GUEST_BIN"
       (str (fs/absolutize (fs/path (env "CARGO_TARGET_DIR" "guest/target") "debug" "spool-guest")))))

(defn test-worker []
  (let [modules (env "SPOOL_TOOL_MODULES" (output "npm" "root" "-g"))
        esbuild (env "SPOOL_ESBUILD" (str (fs/path modules "esbuild/bin/esbuild")))
        workerd (env "SPOOL_WORKERD" (str (fs/path modules "workerd/bin/workerd")))]
    (shell esbuild "test/worker.fixture.mjs" "--bundle" "--format=esm" "--platform=neutral"
           "--external:cloudflare:*" "--outfile=.wrangler/worker.fixture.js")
    (shell workerd "test" (str "-I" modules) "test/worker.capnp")))

(defn worker-check []
  (fs/create-dirs ".wrangler")
  (let [config ".wrangler/dry-run.json"]
    (spit config
          (json/generate-string
           {:name "spool-dry-run"
            :main "../src/worker.mjs"
            :compatibility_date "2025-11-17"
            :workers_dev false
            :preview_urls false
            :durable_objects {:bindings [{:name "TENANTS" :class_name "TenantRunner"}
                                         {:name "GUESTS" :class_name "GuestSlot"}]}
            :migrations [{:tag "v1" :new_sqlite_classes ["TenantRunner" "GuestSlot"]}]
            :r2_buckets [{:binding "LAYERS" :bucket_name "spool-fixture-layers"}]
            :containers [{:class_name "GuestSlot" :image "../guest/Dockerfile"
                          :image_build_context "../guest" :instance_type "standard-2" :max_instances 1}]}))
    (shell (env "SPOOL_WRANGLER" "wrangler") "deploy" "--config" config "--dry-run" "--outdir" ".wrangler/build")))

(defn emit-client [args]
  (let [paths ["client/kin/src" (env "SPOOL_KIN_SRC" "../kin/src") (env "SPOOL_SNUG_KIN_SRC" "../snug/kin/src")]]
    (apply shell "bb" "--classpath" (str/join java.io.File/pathSeparator paths) "client/kin/emit.clj" args)
    (when (empty? args)
      (fs/copy "client/generated/rust/spool/client/replay.rs" "sdk/rust/src/replay.rs" {:replace-existing true}))))

(defn test-cluster []
  (if (System/getenv "SPOOL_NATS_URL")
    (shell "node" "test/live-cluster.mjs")
    (let [broker (output "docker" "run" "-d" "--rm" "-p" "127.0.0.1::4222" "nats:2.11-alpine" "-js")]
      (try
        (let [url (str "nats://" (output "docker" "port" broker "4222/tcp"))]
          (shell {:extra-env {"SPOOL_NATS_URL" url}} "node" "test/live-cluster.mjs"))
        (finally
          (shell "docker" "stop" broker))))))

(defn build-release [destination]
  (let [dest (or destination "dist")
        version (:version (json/parse-string (slurp "package.json") true))]
    (doseq [manifest ["sdk/rust/Cargo.toml" "guest/Cargo.toml"]]
      (when-not (= version (second (re-find #"(?m)^version = \"([^\"]+)\"" (slurp manifest))))
        (throw (ex-info "Rust and npm package versions differ" {:manifest manifest}))))
    (fs/create-dirs dest)
    (shell "cargo" "package" "--locked" "--allow-dirty" "--manifest-path" "sdk/rust/Cargo.toml")
    (fs/copy (fs/path (env "CARGO_TARGET_DIR" "sdk/rust/target") "package" (str "spool-client-" version ".crate"))
             (fs/path dest (str "spool-client-" version ".crate")) {:replace-existing true})
    (when (= "1" (System/getenv "SPOOL_RELEASE_OCI"))
      (let [image (str "spool-guest:" version)
            temp (fs/create-temp-dir {:dir (fs/absolutize dest) :prefix ".spool-image-"})
            tar (str (fs/path temp "guest.tar"))]
        (try
          (shell {:extra-env {"SPOOL_OCI_IMAGE" image}} "node" "bin/runner.mjs" "guest-build")
          (shell "docker" "save" "--output" tar image)
          (shell "gzip" "-n" tar)
          (fs/move (str tar ".gz") (fs/path dest (str "spool-guest-" version "-linux-amd64.tar.gz")) {:replace-existing true})
          (finally (fs/delete-tree temp)))))
    (shell "node" "release/package.mjs" dest)
    (shell "node" "release/check.mjs" dest)))

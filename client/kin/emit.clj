(require '[kin.project :as kp] '[kin.vfs :as vfs] '[snug.targets :as targets])

(let [root (or (first *command-line-args*) "client/generated")
      by-target (into {} (for [[target config] targets/targets]
                           [target (assoc config :vfs (vfs/disk-vfs (str root "/" (name target))))]))
      project (kp/load-project {:vocabularies '[spool.client.types snug.lang snug.js kin.lang]
                                :targets by-target
                                :target-order [:js :rust]})
      path "client/kin/replay.kin"]
  (doseq [result (kp/emit! project (slurp path) path)]
    (println (:target result) (:path result))))

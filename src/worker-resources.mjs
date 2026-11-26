// Cloudflare publishes disk sizes in decimal GB and memory in GiB. Reserve
// space for the guest image, VM services, and the runner before admitting work.
const MiB = 1024 ** 2;
const profile = (name, cpu, memoryGiB, diskGb) => ({
  name, cpu, memory_mib: memoryGiB * 1024 - 256, disk_mib: Math.floor(diskGb * 10 ** 9 / MiB) - 1024,
});
const catalog = [
  profile("standard-2", 1, 6, 12),
  profile("standard-3", 2, 8, 16),
  profile("standard-4", 4, 12, 20),
];

export function workerResourcePolicy(env) {
  if (!env.SPOOL_CONTAINER_IMAGE) return {};
  const defaultName = env.SPOOL_CONTAINER_INSTANCE || "standard-2";
  const defaultIndex = catalog.findIndex(({ name }) => name === defaultName);
  if (defaultIndex < 0) throw new Error("SPOOL_CONTAINER_INSTANCE must name standard-2, standard-3, or standard-4");
  const allowed = env.SPOOL_CONTAINER_INSTANCES?.split(",").map((entry) => entry.trim())
    ?? catalog.slice(defaultIndex).map(({ name }) => name);
  if (!allowed.includes(defaultName) || allowed.some((entry) => !catalog.some(({ name }) => name === entry))) {
    throw new Error("SPOOL_CONTAINER_INSTANCES must contain supported profiles including SPOOL_CONTAINER_INSTANCE");
  }
  return {
    default_resource_profile: defaultName,
    resource_profiles: catalog.filter(({ name }) => allowed.includes(name)),
  };
}

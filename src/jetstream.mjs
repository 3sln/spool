const milliseconds = (value) => value * 1_000_000;

export async function connectQueue(env, provision) {
  const [{ connect }, { jetstream, jetstreamManager }] = await Promise.all([
    import("@nats-io/transport-node"), import("@nats-io/jetstream"),
  ]).catch((error) => {
    throw new Error("Install the optional NATS dependencies to use JetStream", { cause: error });
  });
  const nc = await connect({
    servers: env.SPOOL_NATS_URL.split(","),
    ...(env.SPOOL_NATS_TOKEN ? { token: env.SPOOL_NATS_TOKEN } : {}),
    ...(env.SPOOL_NATS_USER ? { user: env.SPOOL_NATS_USER, pass: env.SPOOL_NATS_PASSWORD } : {}),
    maxReconnectAttempts: -1,
  });
  try {
    const stream = env.SPOOL_NATS_STREAM ?? "SPOOL";
    if (!/^[A-Z][A-Z0-9_]*$/u.test(stream)) throw new Error("Invalid JetStream stream name");
    const subject = `spool.${stream}.run`;
    const durable = "spool-executors";
    const manager = await jetstreamManager(nc);
    if (provision) {
      try { await manager.streams.info(stream); }
      catch (error) {
        if (error.status !== 404) throw error;
        await manager.streams.add({
          name: stream, subjects: [subject], retention: "workqueue", storage: "file",
          discard: "new", max_msgs: 10_000, max_msg_size: 1024, max_age: milliseconds(60 * 60_000),
          duplicate_window: milliseconds(10 * 60_000),
          num_replicas: Number(env.SPOOL_NATS_REPLICAS ?? 1),
        });
      }
      try { await manager.consumers.info(stream, durable); }
      catch (error) {
        if (error.status !== 404) throw error;
        await manager.consumers.add(stream, {
          durable_name: durable, filter_subject: subject, ack_policy: "explicit",
          ack_wait: milliseconds(30_000), max_ack_pending: 256,
        });
      }
    }
    const streamInfo = await manager.streams.info(stream);
    const consumerInfo = await manager.consumers.info(stream, durable);
    if (streamInfo.config.retention !== "workqueue" || !streamInfo.config.subjects.includes(subject)
      || consumerInfo.config.filter_subject !== subject || consumerInfo.config.ack_policy !== "explicit"
      || consumerInfo.config.deliver_subject) {
      throw new Error("Existing JetStream stream or consumer configuration is incompatible");
    }
    const client = jetstream(nc);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      publish: (job) => client.publish(subject, encoder.encode(JSON.stringify(job)), { msgID: job.epoch }),
      consumer: () => client.consumers.get(stream, durable),
      decode: (message) => JSON.parse(decoder.decode(message.data)),
      close: () => nc.close(),
    };
  } catch (error) {
    await nc.close();
    throw error;
  }
}

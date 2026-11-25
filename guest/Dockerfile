FROM --platform=$BUILDPLATFORM rust:1.92.0-alpine@sha256:f6c22e0a256c05d44fca23bf530120b5d4a6249a393734884281ca80782329bc AS build
WORKDIR /build
RUN rustup target add x86_64-unknown-linux-musl
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    if [ "$(uname -m)" != x86_64 ]; then export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld; fi \
    && cargo build --release --locked --target x86_64-unknown-linux-musl \
    && cp target/x86_64-unknown-linux-musl/release/spool-guest /spool-guest

FROM debian:bookworm-slim@sha256:311f7a192fd9a92b165a86b32fa3aae9005b11849bfb1db2d4fd784559ee464f
COPY --from=build --chmod=0555 /spool-guest /usr/local/bin/spool-guest
RUN install -d -o 65532 -g 65532 -m 0755 /workspace
ENTRYPOINT ["/usr/local/bin/spool-guest"]
CMD ["http"]

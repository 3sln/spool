FROM python:3.13-slim-bookworm@sha256:70bda1e795ded2a684ef9815955e05829b14ee5bb5c3eb2a940648e88f10fce9
COPY --chmod=0555 runner.py /opt/spool/runner.py
RUN install -d -o 65532 -g 65532 -m 0755 /workspace
ENTRYPOINT ["/usr/local/bin/python", "-I", "/opt/spool/runner.py"]
CMD ["http"]

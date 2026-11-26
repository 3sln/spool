# Spool releases

The release version comes from [version.edn](../version.edn). The workflow stamps
manifests and lockfiles in its build checkout. Use `bb stamp` in a local release
checkout to reproduce a build after changing the version.

## First npm publish

Use the `spool-release` artifact from the Release workflow on main and verify
its `SHA256SUMS`. If necessary, assemble the same tarball locally from that
commit with `bb stamp` and `bb release-pack`. Sign in to npm as an account
with publishing access to the `@3sln` scope.

```sh
npm login
npm publish ./dist/3sln-spool-mcp-0.1.0.tgz --access public
npm install -g @3sln/spool-mcp
spool-mcp --version
```

Once the package exists, add a GitHub Actions trusted publisher in its npm
settings. Set the owner to `3sln`, repository to `spool`, and workflow filename
to `release.yml`. Leave the environment blank and allow direct publishing.
On an npm CLI that supports `npm trust`, the equivalent command is:

```sh
npm trust github @3sln/spool-mcp --repo 3sln/spool --file release.yml --allow-publish
```

npm may require two-factor authentication. Complete the next version bump
within npm's initial trusted-publisher activation window.
[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
[npm trust](https://docs.npmjs.com/cli/commands/npm-trust/)

For the first GitHub release, dispatch the Release workflow on the same main
commit with `publish` enabled. It verifies that the existing npm version
contains the expected tarball. Subsequent version changes on main publish
automatically. Dispatch with both inputs disabled to build and verify assets,
or select `draft` to stage a GitHub draft. The automatic workflow does not
include the prebuilt OCI guest image.

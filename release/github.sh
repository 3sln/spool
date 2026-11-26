#!/usr/bin/env bash
set -euo pipefail
tag="v$VERSION"
(cd dist && sha256sum -c SHA256SUMS)
tag_sha=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f1)
if [[ -n "$tag_sha" && "$tag_sha" != "$GITHUB_SHA" ]]; then
  echo "$tag belongs to a different commit" >&2
  exit 1
fi

flags=()
if [[ "$VERSION" == *-* ]]; then flags+=(--prerelease); fi
if [[ "$DRAFT" == true ]]; then flags+=(--draft); fi
if existing=$(gh release view "$tag" --json isDraft,targetCommitish); then
  if [[ $(jq -r .isDraft <<< "$existing") != true ]]; then
    [[ "$tag_sha" == "$GITHUB_SHA" ]]
    echo "$tag is already public"
    exit
  fi
  [[ $(jq -r .targetCommitish <<< "$existing") == "$GITHUB_SHA" ]] || exit 1
  # A prior draft may contain files from a different release policy.
  # Require its existing assets to be part of this verified bundle.
  for asset in $(gh release view "$tag" --json assets --jq '.assets[].name'); do
    [[ -f "dist/$asset" ]] || exit 1
  done
  gh release upload "$tag" dist/* --clobber
  if [[ "$DRAFT" != true ]]; then gh release edit "$tag" --draft=false "${flags[@]}"; fi
else
  gh release create "$tag" dist/* --target "$GITHUB_SHA" --title "Spool $VERSION" --notes-file CHANGELOG.md "${flags[@]}"
fi

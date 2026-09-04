# AUR packaging (optional)

This directory maintains the [`code-work-bin`](https://aur.archlinux.org/packages/code-work-bin) and
[`code-work-nightly-bin`](https://aur.archlinux.org/packages/code-work-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

## Current release policy

The normal desktop release workflow does not publish to AUR. The former GitHub Actions workflow
was removed because this repository only needs GitHub Releases for desktop artifacts. This directory
is retained only for maintainers who explicitly want to validate or publish an Arch package by hand.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```

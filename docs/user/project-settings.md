# Customize a project icon

Code Work selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

Code Work supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Project defaults

Settings → Projects → select a project also controls what new threads in that project start
with:

- **Default model** — the provider model new threads use before you pick one in the composer.
- **New-thread workspace** — whether threads start in the project's current checkout or a new
  Git worktree.
- **Default permissions** — the permission mode new threads start in, overriding the global
  default under Settings → General.
- **Worktree submodules** — how deeply a new worktree initializes git submodules: recursive,
  top-level only, or none (left for setup scripts).

Each project setting can be left on its "Default" choice, which inherits the server-wide value —
or, for workspace mode and submodules, the value declared in the repository's `t3.json` file
(`defaultThreadEnvMode` and `worktreeSubmodules`), so a checked-in default follows every checkout
of the project.

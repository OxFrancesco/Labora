# Anti-slop provenance

Installed 2026-10-02 from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit [`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/skills/install-anti-slop/assets/anti-slop).

Source directory: `skills/install-anti-slop/assets/anti-slop/`.
Installed directory: `tools/oxlint/anti-slop/`.
Entrypoints: `index.ts` and `effect/index.ts`.

All 38 copied files matched the Git blob SHA-1 values from the upstream tree at that exact commit. This was checked against the installed files, not inferred from upstream HEAD. No rule, diagnostic, or implementation changes were made. This provenance document and the upstream project MIT `LICENSE` are the only added files.

Snapshot SHA-256: `fe21a1d9ae78234cf53837c6d448ded8126b73c8c1a9391008deff318ce75982`.

The snapshot digest hashes the concatenation of each relative path, a NUL byte, its file-content SHA-256, and a newline, ordered lexicographically by relative path. It excludes the top-level `UPSTREAM.md` and `LICENSE`, and includes the nested `vendor/eslint-stylistic/UPSTREAM.md` and license.

`skills-lock.json` records source `dmmulroy/anti-slop`, skill path `skills/install-anti-slop/SKILL.md`, and skill installer hash `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`. That installer hash is separate from the verified plugin snapshot digest above.

Oxlint and `@oxlint/plugins` are both pinned to `1.86.0`. All 18 generic rules, all five Effect rules, and the native `oxc/no-accumulating-spread` companion are enabled at error severity in `oxlint.config.ts`. No suppressions or reduced severities were added. The Effect import rule covers relative project imports; it does not enforce package-alias imports.

The Stylistic rule's original license and provenance remain under `vendor/eslint-stylistic/`.

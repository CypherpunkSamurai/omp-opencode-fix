# Publishing

## Name and links

The package name is `omp-opencode-fix`. Repository, homepage, and issue links
point to https://github.com/CypherpunkSamurai/omp-opencode-fix.

Keep the `pi-package` keyword and both manifest keys (`omp.extensions`,
`pi.extensions`): omp and Pi both discover installed plugin packages by their
package manifest, and the legacy key costs nothing.

## No build step

omp loads the shipped TypeScript with Bun. `files` ships `src/**/*.ts`,
`README.md`, `LICENSE`, and `CHANGELOG.md`; tests, CI, `node_modules`, and local
settings stay out.

## Dependencies

`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, and `@oh-my-pi/pi-coding-agent` are
peer-only. omp's extension loader rewrites canonical `@oh-my-pi/pi-*` specifiers
(including subpaths such as `@oh-my-pi/pi-catalog/models`) onto the host's
in-process modules, so a plugin does not need its own copy on disk. Verified by
deleting `node_modules` from a checkout: `omp models opencode-zen-free` still
loaded the extension and listed the roster. The same packages are pinned in
`devDependencies` for type checking and fixture tests; bump them together when
re-validating against a new omp.

## Release

```sh
npm ci --ignore-scripts
npm run verify           # tsc + Bun fixture tests + pack dry run

bun run test/live        # optional: real anonymous free-tier requests
```

Commit and push the reviewed release, then publish with the npm account that
owns the name:

```sh
npm login
npm publish --access public
```

After publishing, confirm the installed plugin in omp:

```sh
omp plugin install omp-opencode-fix
omp plugin doctor
omp models opencode-zen-free
```

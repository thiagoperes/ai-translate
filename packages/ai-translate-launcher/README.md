# ai-translate

Run the shared ai-translate CLI directly with npm:

```sh
npx ai-translate init
npx ai-translate sync
```

`init` detects native Apple, next-intl, and i18next resources, creates the configuration and package scripts, and installs its dependencies. Use `init --preview` to inspect the setup without changing files, or `init --no-install` to prepare it and install dependencies yourself.

This package forwards commands to [`@ai-translate/cli`](https://github.com/thiagoperes/ai-translate/tree/main/packages/ai-translate-cli). Existing scoped CLI installations and imports continue to work. `--version` reports the shared CLI version.

See the [project documentation](https://github.com/thiagoperes/ai-translate#readme) for configuration, adapters, and providers.

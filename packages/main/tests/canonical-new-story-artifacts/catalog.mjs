export const GROUPS = Object.freeze(['scope', 'init', 'runtime', 'runtime-topology', 'release', 'inventory', 'identity-cutover', 'identity-migration-archive', 'identity-consumer-smoke', 'identity-inventory', 'identity-cache', 'identity-sites', 'identity-canonical', 'identity-config-boundary', 'identity-policy', 'identity-policy-boundary', 'identity-snapshot', 'identity-entrypoint', 'reviewer-read', 'f050', 'round23', 'round24', 'memory-identity', 'artifact-append', 'finding-trust']);

export const CAPABILITIES = Object.freeze([
  {
    "id": "scope",
    "legacyArgument": "--group=scope",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "scope-init.mjs",
        "checkSites": 12
      }
    ]
  },
  {
    "id": "init",
    "legacyArgument": "--group=init",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "scope-init.mjs",
        "checkSites": 12
      }
    ]
  },
  {
    "id": "runtime",
    "legacyArgument": "--group=runtime",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-runtime-boundaries.mjs",
        "checkSites": 7
      },
      {
        "module": "memory-runtime.mjs",
        "checkSites": 5
      },
      {
        "module": "runtime-extensions.mjs",
        "checkSites": 4
      },
      {
        "module": "runtime-read.mjs",
        "checkSites": 4
      },
      {
        "module": "runtime-topology.mjs",
        "checkSites": 10
      },
      {
        "module": "scope-init.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "runtime-topology",
    "legacyArgument": "--group=runtime-topology",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "runtime-topology.mjs",
        "checkSites": 3
      }
    ]
  },
  {
    "id": "release",
    "legacyArgument": "--group=release",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "finding-artifacts.mjs",
        "checkSites": 2
      },
      {
        "module": "release.mjs",
        "checkSites": 8
      }
    ]
  },
  {
    "id": "inventory",
    "legacyArgument": "--group=inventory",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "artifact-inventory.mjs",
        "checkSites": 8
      },
      {
        "module": "runtime-read.mjs",
        "checkSites": 1
      },
      {
        "module": "scope-init.mjs",
        "checkSites": 2
      }
    ]
  },
  {
    "id": "identity-cutover",
    "legacyArgument": "--group=identity-cutover",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "finding-artifacts.mjs",
        "checkSites": 3
      },
      {
        "module": "identity-cutover.mjs",
        "checkSites": 4
      },
      {
        "module": "identity-inventory.mjs",
        "checkSites": 3
      },
      {
        "module": "identity-policy.mjs",
        "checkSites": 3
      },
      {
        "module": "identity-runtime-boundaries.mjs",
        "checkSites": 2
      },
      {
        "module": "identity-sites.mjs",
        "checkSites": 4
      },
      {
        "module": "release.mjs",
        "checkSites": 1
      },
      {
        "module": "scope-init.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-migration-archive",
    "legacyArgument": "--group=identity-migration-archive",
    "archived": true,
    "completeSuite": false,
    "bindings": [
      {
        "module": "migration-archive.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-consumer-smoke",
    "legacyArgument": "--group=identity-consumer-smoke",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-inventory",
    "legacyArgument": "--group=identity-inventory",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-inventory.mjs",
        "checkSites": 2
      },
      {
        "module": "identity-runtime-boundaries.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-cache",
    "legacyArgument": "--group=identity-cache",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-inventory.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-sites",
    "legacyArgument": "--group=identity-sites",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-sites.mjs",
        "checkSites": 7
      }
    ]
  },
  {
    "id": "identity-canonical",
    "legacyArgument": "--group=identity-canonical",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-sites.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-config-boundary",
    "legacyArgument": "--group=identity-config-boundary",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 2
      },
      {
        "module": "identity-sites.mjs",
        "checkSites": 2
      }
    ]
  },
  {
    "id": "identity-policy",
    "legacyArgument": "--group=identity-policy",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "identity-policy-boundary",
    "legacyArgument": "--group=identity-policy-boundary",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 2
      },
      {
        "module": "identity-sites.mjs",
        "checkSites": 2
      }
    ]
  },
  {
    "id": "identity-snapshot",
    "legacyArgument": "--group=identity-snapshot",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-sites.mjs",
        "checkSites": 3
      }
    ]
  },
  {
    "id": "identity-entrypoint",
    "legacyArgument": "--group=identity-entrypoint",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "release.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "reviewer-read",
    "legacyArgument": "--group=reviewer-read",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "runtime-read.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "f050",
    "legacyArgument": "--group=f050",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 1
      },
      {
        "module": "identity-sites.mjs",
        "checkSites": 1
      }
    ]
  },
  {
    "id": "round23",
    "legacyArgument": "--group=round23",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-sites.mjs",
        "checkSites": 4
      }
    ]
  },
  {
    "id": "round24",
    "legacyArgument": "--group=round24",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "identity-policy.mjs",
        "checkSites": 3
      },
      {
        "module": "identity-sites.mjs",
        "checkSites": 9
      }
    ]
  },
  {
    "id": "memory-identity",
    "legacyArgument": "--group=memory-identity",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "memory-runtime.mjs",
        "checkSites": 3
      }
    ]
  },
  {
    "id": "artifact-append",
    "legacyArgument": "--group=artifact-append",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "finding-artifacts.mjs",
        "checkSites": 2
      }
    ]
  },
  {
    "id": "finding-trust",
    "legacyArgument": "--group=finding-trust",
    "archived": false,
    "completeSuite": false,
    "bindings": [
      {
        "module": "finding-artifacts.mjs",
        "checkSites": 1
      }
    ]
  }
]);

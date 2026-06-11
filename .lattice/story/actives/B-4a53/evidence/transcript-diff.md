# Authority Strong Evidence Transcript Diff: B-4a53

Authority readiness: BLOCKED (authorityUrlConfigured=false, actorKeyConfigured=false, runnerConfigured=false, sessionConfigured=false, serverPublicKeyPinned=false)
Authority receipt: BLOCKED (no verified AuthorityReceipt; receiptVerified=false; productionDone=false)
Authority strong evidence verification: BLOCKED fail-closed

## Scope

This transcript records the real diagnostic commands used to produce the Authority strong-evidence artifacts. The result is intentionally fail-closed because no verified AuthorityReceipt exists, no Authority URL is configured, and no production-done claim can be made.

## Command Transcript

### Required session intake

Command:

```sh
lattice session_brief
```

Result: exit 0. Story B-4a53 is in DEV phase in this worktree. Existing dirty story metadata was present before these artifacts were written and was not added to this commit.

Command:

```sh
lattice aux_doc_list
```

Result: exit 0. Project docs were listed successfully.

### Authority status

Command:

```sh
lattice authority_status --json
```

Result: exit 0.

```text
[0.0s] running authority_status...
[0.0s] authority_status done
{
  "schemaVersion": "lattice.authority_status.v1",
  "product": {
    "name": "Lattice CLI",
    "version": "0.3.5"
  },
  "authorityMode": "off",
  "mode": "off",
  "baseURLConfigured": false,
  "baseURL": null,
  "timeoutMS": 10000,
  "resolvedBaseURL": null,
  "urlSource": "none",
  "defaultUrlApplied": false,
  "authorityMdLoaded": false,
  "testKeyProfile": null,
  "productionInert": false,
  "productionInertReasons": [],
  "serverReachability": "not-probed",
  "receiptVerified": false,
  "productionDone": false,
  "canClaimProductionDone": false,
  "status": "not-configured",
  "localWorkflowUsable": true,
  "authorityUrlConfigured": false,
  "customerApiKeyConfigured": false,
  "customerApiKeySource": "missing",
  "customerApiKeyValid": "unknown",
  "actorKeyConfigured": false,
  "actorKeyRegistered": "unknown",
  "serverPublicKeyPinned": false,
  "runnerConfigured": false,
  "sessionConfigured": false,
  "productionAuthorityUsable": false,
  "readinessWarnings": [],
  "nextActions": [],
  "localWorkflowNote": "Local workflow (story_advance / verification_evidence_add / DONE gate) does not depend on remote authority; missing enforce prerequisites are readiness warnings, not global blockers.",
  "note": "Receipt-aware status only: no receipt is verified, no evidence is submitted, and productionDone remains false."
}
```

### Conduit status

Command:

```sh
lattice conduit_status --json
```

Result: exit 0.

```text
[0.0s] running conduit_status...
[0.0s] conduit_status done
{
  "schemaVersion": "lattice.conduit_status.v1",
  "product": {
    "name": "Lattice CLI",
    "version": "0.3.5"
  },
  "conduitAvailable": true,
  "conduitRole": "cli-diagnostics-and-handoff",
  "runnerProvisioned": false,
  "modelRunnerCreated": false,
  "productionDone": false,
  "receiptVerified": false,
  "authorityChanged": false,
  "localWorkflowUsable": true,
  "mode": "off",
  "authorityUrlConfigured": false,
  "actorKeyConfigured": false,
  "runnerConfigured": false,
  "sessionConfigured": false,
  "readinessWarnings": [],
  "nextActions": [],
  "localWorkflowNote": "Local workflow (story_advance / verification_evidence_add / DONE gate) does not depend on remote authority; missing enforce prerequisites are readiness warnings, not global blockers.",
  "supportedSurfaces": [
    "host_list",
    "host_probe",
    "host_status",
    "host_install",
    "lattice_config_doctor",
    "authority_status",
    "handoff_create",
    "handoff_accept",
    "handoff_resume",
    "handoff_receipt_submit",
    "handoff_worktree_create",
    "host_dispatch",
    "evidence_manifest",
    "evidence_inspect",
    "parallel_wave_create",
    "parallel_plan"
  ],
  "warnings": [
    "The CLI conduit coordinates diagnostics and handoff projections only.",
    "It does not provision a new model runner, sign envelopes, verify receipts, or grant production authority."
  ]
}
```

### Authority enforce policy

Command:

```sh
lattice authority_enforce_policy --json
```

Result: exit 1.

```text
[0.0s] running authority_enforce_policy...
[0.0s] authority_enforce_policy failed: ❌ LATTICE_AUTHORITY_URL is not set; authority policy discovery requires an authority server URL.
Authority policy discovery only: no receipt, no gate pass, no evidence submission.
Error: ❌ LATTICE_AUTHORITY_URL is not set; authority policy discovery requires an authority server URL.
Authority policy discovery only: no receipt, no gate pass, no evidence submission.
```

### Environment presence check

Command:

```sh
node -e 'const names=["KOALA_AUTHORITY_MODE","KOALA_AUTHORITY_URL","KOALA_AUTHORITY_TIMEOUT_MS","KOALA_AUTHORITY_ACTOR_KEY","KOALA_AUTHORITY_ACTOR_KEY_PATH","KOALA_AUTHORITY_RUNNER_ID","KOALA_AUTHORITY_SESSION_ID","KOALA_AUTHORITY_SERVER_PUBLIC_KEY","KOALA_AUTHORITY_SERVER_PUBLIC_KEY_PATH","KOALA_AUTHORITY_LIVE_URL","KOALA_AUTHORITY_LIVE_PUBLIC_KEY","LATTICE_AUTHORITY_MODE","LATTICE_AUTHORITY_URL","LATTICE_AUTHORITY_TIMEOUT_MS","LATTICE_AUTHORITY_ACTOR_KEY","LATTICE_AUTHORITY_ACTOR_KEY_PATH","LATTICE_AUTHORITY_RUNNER_ID","LATTICE_AUTHORITY_SESSION_ID","LATTICE_AUTHORITY_SERVER_PUBLIC_KEY","LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_PATH"]; const entries=Object.fromEntries(names.map(name=>[name,{present:Object.prototype.hasOwnProperty.call(process.env,name),nonEmpty:!!(process.env[name]&&process.env[name].trim())}])); const grouped={urlConfigured:!!(process.env.KOALA_AUTHORITY_URL?.trim()||process.env.LATTICE_AUTHORITY_URL?.trim()),actorKeyConfigured:!!(process.env.KOALA_AUTHORITY_ACTOR_KEY?.trim()||process.env.KOALA_AUTHORITY_ACTOR_KEY_PATH?.trim()||process.env.LATTICE_AUTHORITY_ACTOR_KEY?.trim()||process.env.LATTICE_AUTHORITY_ACTOR_KEY_PATH?.trim()),runnerConfigured:!!(process.env.KOALA_AUTHORITY_RUNNER_ID?.trim()||process.env.LATTICE_AUTHORITY_RUNNER_ID?.trim()),sessionConfigured:!!(process.env.KOALA_AUTHORITY_SESSION_ID?.trim()||process.env.LATTICE_AUTHORITY_SESSION_ID?.trim()),serverPublicKeyPinned:!!(process.env.KOALA_AUTHORITY_SERVER_PUBLIC_KEY?.trim()||process.env.KOALA_AUTHORITY_SERVER_PUBLIC_KEY_PATH?.trim()||process.env.KOALA_AUTHORITY_LIVE_PUBLIC_KEY?.trim()||process.env.LATTICE_AUTHORITY_SERVER_PUBLIC_KEY?.trim()||process.env.LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_PATH?.trim())}; console.log(JSON.stringify({checkedAt:new Date().toISOString(),redacted:true,entries,grouped},null,2));'
```

Result: exit 0.

```json
{
  "checkedAt": "2026-06-10T01:59:57.742Z",
  "redacted": true,
  "entries": {
    "KOALA_AUTHORITY_MODE": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_URL": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_TIMEOUT_MS": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_ACTOR_KEY": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_ACTOR_KEY_PATH": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_RUNNER_ID": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_SESSION_ID": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_SERVER_PUBLIC_KEY": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_SERVER_PUBLIC_KEY_PATH": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_LIVE_URL": {
      "present": false,
      "nonEmpty": false
    },
    "KOALA_AUTHORITY_LIVE_PUBLIC_KEY": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_MODE": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_URL": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_TIMEOUT_MS": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_ACTOR_KEY": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_ACTOR_KEY_PATH": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_RUNNER_ID": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_SESSION_ID": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_SERVER_PUBLIC_KEY": {
      "present": false,
      "nonEmpty": false
    },
    "LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_PATH": {
      "present": false,
      "nonEmpty": false
    }
  },
  "grouped": {
    "urlConfigured": false,
    "actorKeyConfigured": false,
    "runnerConfigured": false,
    "sessionConfigured": false,
    "serverPublicKeyPinned": false
  }
}
```

### Authority job create

Result: skipped due missing URL. Readiness proved no Authority URL is configured (`authority_status.authorityUrlConfigured=false`, `authority_status.baseURLConfigured=false`, and environment `grouped.urlConfigured=false`), so no real Authority job target exists. No job id was invented.

### Mechanical verification

Command:

```sh
node -e 'const fs=require("fs"); const json=".omx/artifacts/authority/B-4a53/authority-strong-evidence-report.json"; const md=".omx/artifacts/authority/B-4a53/authority-strong-evidence-report.md"; const tx=".koala/story/actives/B-4a53/evidence/transcript-diff.md"; const report=JSON.parse(fs.readFileSync(json,"utf8")); const markdown=fs.readFileSync(md,"utf8"); const transcript=fs.readFileSync(tx,"utf8"); const lines=["Authority readiness: BLOCKED (authorityUrlConfigured=false, actorKeyConfigured=false, runnerConfigured=false, sessionConfigured=false, serverPublicKeyPinned=false)","Authority receipt: BLOCKED (no verified AuthorityReceipt; receiptVerified=false; productionDone=false)","Authority strong evidence verification: BLOCKED fail-closed"]; const failures=[]; function check(cond,msg){if(!cond) failures.push(msg);} function hasKey(value,key){if(Array.isArray(value)) return value.some(v=>hasKey(v,key)); if(value&&typeof value==="object") return Object.keys(value).some(k=>k===key||hasKey(value[k],key)); return false;} check(report.storyId==="B-4a53","storyId"); check(report.strongEvidenceResult==="BLOCKED_FAIL_CLOSED","strongEvidenceResult"); check(report.authorityMode==="off","authorityMode"); check(report.receiptVerified===false,"receiptVerified"); check(report.productionDone===false,"productionDone"); check(report.strongEvidenceConsumed===false,"strongEvidenceConsumed"); check(report.authorityReadiness.authorityUrlConfigured===false,"authorityUrlConfigured"); check(report.authorityReadiness.actorKeyConfigured===false,"actorKeyConfigured"); check(report.authorityReadiness.runnerConfigured===false,"runnerConfigured"); check(report.authorityReadiness.sessionConfigured===false,"sessionConfigured"); check(report.authorityReadiness.serverPublicKeyPinned===false,"serverPublicKeyPinned"); check(!hasKey(report,"jobId"),"unexpected jobId"); check(!hasKey(report,"receiptId"),"unexpected receiptId"); check(!hasKey(report,"receiptFile"),"unexpected receiptFile"); for (const line of lines) { check(markdown.includes(line),`markdown missing ${line}`); check(transcript.includes(line),`transcript missing ${line}`); } if (failures.length) { console.error(failures.join("\n")); process.exit(1); } console.log("authority strong evidence artifact verification: PASS");'
```

Result: exit 0.

```text
authority strong evidence artifact verification: PASS
```

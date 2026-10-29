# Search release profile

Use the existing transactional publisher with an explicit `search` profile.
The default CLI and `ainvr-ptz-v1` rollback records remain compatible.

```sh
python3 deploy-package/build-onvif-release.py --profile search --output out/search-release-YYYYMMDD
python3 deploy-package/prepare-ptz-components.py --profile search --candidate out/search-release-YYYYMMDD
python3 deploy-package/deploy_ptz_release.py --profile search --check out/search-release-YYYYMMDD
```

These commands prepare/verify a candidate only. Compilation selects the native
AI, LLM and search executables; search requires BPU text and the checked
tokenizer. Hardware probes are disabled and no executable/model is invoked by
the component builder. Build-only pinned tokenizer dependencies must already be
available; Cargo downloads are disabled. ELF dependency inspection rejects SSD
or build-directory runtime paths. Models, tokenizers and model sidecars remain
in the existing system-disk `ai-service/models` tree and are never packaged.

The read-only `--check` verifies frozen sources, artifacts, architecture and
build contracts. It does not inspect credentials, access PG, create an identity,
stop services or write backups. A successful check is not deployment, hardware
acceptance or a real rollback rehearsal.

An explicitly authorized administrator may then run:

```sh
sudo python3 deploy-package/deploy_ptz_release.py --profile search --apply out/search-release-YYYYMMDD
sudo python3 deploy-package/deploy_ptz_release.py --rollback /mnt/ainvr-ssd/ainvr-rollback/backend/TRANSACTION
```

The same publication lock, atomic tree exchange, SSD integrity inventory,
per-service retention (maximum three), incomplete-transaction detection and
rollback entrypoint are reused. Only AI, LLM, search, console backend/frontend
and the host helper are replaced. ONVIF, GB, SRS, recorder, ingest and alarm
process identities must stay unchanged. Existing service enablement and running
intent are preserved; a newly introduced search daemon is enabled/started but
the application's search `enabled` setting and storage selection are untouched.

The new search management identity is created only during explicit apply using
an independent cryptographic key, private `0600` sunrise-owned bootstrap/env
files and the existing backend service-token loader. Existing valid identity is
retained. Secrets are neither printed nor put in process arguments. The search
unit has a restart burst limit and uses the existing shared `/run/ainvr`
tmpfiles policy without deleting another model process's lease directory.

LLM review uses the independent encrypted `search-verify` caller provisioned
by the existing **System configuration → LLM → Save and apply** preparation
transaction. This publisher does not publish a replacement desired document,
enable LLM/search, select a disk or borrow the alarm key. Without that caller,
the existing UI/runner reports task unavailable and links to configuration.

Rollback stops search and AI sampling before restoring old AI/LLM bytes. It
verifies the SSD inventory and concurrent deployment/configuration guards,
restores private env/unit/helper files, materializes the old LLM executable at a
stable system-disk path, and restores original running intent. It does not need
an old eMMC LLM release directory. New search identity/unit/enablement is removed
when it did not exist before apply. Additive PG migrations and history are kept;
PG values are not reset. A failed stop or concurrent customer edit blocks unsafe
restoration rather than starting another model over uncertain ownership.

The preservation check permits exactly migration 020's untouched 018 seed
transition to the disabled SigLIP2 default. A read-only proof reuses the pinned
migration's entire eligibility SQL, computes the expected document hash, and
then requires the matching migration audit/version/full snapshot. User-edited
settings, existing search credentials, unrelated documents or a different
migration source do not qualify. No plaintext configuration is emitted.

Software fixtures: `python3 -m unittest discover -s test/ptz -p 'test_*deploy*.py'`
and `python3 -m unittest discover -s test/ptz -p test_search_release.py`. They use
private temporary files and fake service/subprocess responses; actual candidate
build, production check and an explicitly scheduled real SSD rollback rehearsal
remain separate release gates.

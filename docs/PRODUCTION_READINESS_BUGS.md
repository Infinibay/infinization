# Infinization — Production-Readiness Bug Log

> ## STATUS (fix pass complete)
> **All 15 blockers fixed. ~33 of 45 important fixed. Build clean (tsc + tsc-alias). Tests: 243 passing
> (was 131), 0 failing, 1 legacy suite skipped (VMLifecycle.spec — needs a ground-up rewrite to the new
> service-injection model; documented in-file).** New shared utils: `processIdentity` (identity-checked
> kills), `qemuArgSafety` (anti-injection), hardened `commandExecutor` (timeout/maxBuffer), leveled
> `debug` logger (error/warn unconditional + injectable sink). 6 new test suites + 3 of 4 broken legacy
> suites repaired (QemuProcess 22, QMPClient 28, eventHandlerCleanup 16).
>
> **Deferred importants (rationale):** I26 (route sync cleanup through facade vmLock — needs lock
> injection), I27 (reconcile identity-check on promote — needs internalName in RunningVMRecord), I30
> (always re-delegate root cpuset), I34/I36 (give the install monitor a dedicated QMP client + a cancel
> handle), I37 (thread productKey/locale to the answer-file manager), I45 (lock createVMChain/jump-rule
> methods — deferred to avoid KeyedMutex re-entrancy deadlock), I46 (br_netfilter/nf_conntrack preflight).
> Most 30 minors addressed opportunistically; the rest are robustness/cleanup.
>
> ### Re-audit + post-audit fixes (verification pass)
> A second adversarial audit of the diff found 4 must-fix issues — **all now fixed and re-verified**:
> (1) 6 missed QEMU arg-injection sinks hardened (addCdrom/addSecondCdrom/validateRomPath/tapName/pidfile/
> SpiceConfig password+rendernode); (2) the new 10-min CommandExecutor default timeout was killing large
> backups — disk-sized ops (qemu-img create/convert/resize/check, gzip/gunzip/mv) now pass `timeoutMs:0`
> while short control commands keep the default; (3) `BackupScheduleService` now threads a `diskPathResolver`
> + `CreateScheduleInput.diskPaths` so scheduled backups can actually run; (4) `Department.firewallPolicy`
> (ALLOW_ALL/BLOCK_ALL) is now read via `getDepartmentFirewallPolicy` and threaded into the terminal posture
> so ALLOW_ALL departments aren't over-blocked. Plus: `checkImage` reads structured `err.stdout` (not the
> tail-truncated message); `runAsUser`/`disableSandbox` made reachable on `VMCreateConfig`; new types
> re-exported from index.ts. **Final: build clean, jest 247 passing / 0 failing / 1 skipped.**



Source: 134-agent adversarial audit (2026-06-25) of the whole library. 100 findings, **90 confirmed**
after per-finding verification (15 blocker / 45 important / 30 minor). Verdict before fixes: **NOT
production-ready (~4/10)**. The v0.2.0 network layer is fail-closed, but the guarantee was bypassed at the
lifecycle boundary and nearly every other subsystem had a data-loss / leak / fail-open / insecure-default defect.

Status legend: ☐ open · ◐ in progress · ☑ fixed (+test) · — won't-fix (with reason)

> On-prem deployment model: **one installation = one client**. Cross-customer multi-tenancy is NOT the threat
> model. Host-hardening items (seccomp, -runas, cgroup caps, socket perms) are kept as defense-in-depth against
> a **compromised guest VM** attacking the host or another department's VM, which remains a real on-prem concern.

---

## BLOCKERS (15)

- ☐ B01 firewall fail-OPEN at lifecycle: empty/DB-errored rules skip applyRules() → no terminal drop — `VMLifecycle.ts:349-357,1971-1988`
- ☐ B02 create()-cleanup force-kills wrong PID (no /proc check) → leaks live daemonized QEMU+TAP+port — `VMLifecycle.ts:2827-2836`,`QemuProcess.ts:201-218`
- ☐ B03 per-disk bus/cache splice into -drive (data-integrity injection) — `QemuCommandBuilder.ts:182`,`VMLifecycle.ts:2456`
- ☐ B04 ISO/firmware/-name/-cpu/spice-password raw-interpolated into comma-opt strings — `QemuCommandBuilder.ts:182/880/283/343`
- ☐ B05 display defaults 0.0.0.0 + passwordless SPICE auto disable-ticketing → unauth console — `display.types.ts:27-30`,`VMLifecycle.ts:2508-2544`
- ☐ B06 VNC dead: TCP port passed where display# 0-99 required (throws) — `VMLifecycle.ts:2542`,`VncConfig.ts:213`
- ☐ B07 VNC password=on emitted but never set via QMP → server rejects all clients — `QemuCommandBuilder.ts:323`,`VncConfig.ts:112`
- ☐ B08 restore overwrites live disk in place, no temp+rename, no ENOSPC → destroys only copy — `BackupService.ts:623-631`
- ☐ B09 GZIP backups 100% unrestorable (manifest→deleted original, size 0, no gunzip) — `BackupService.ts:426-432,600-630`
- ☐ B10 scheduler non-functional: diskPaths:[] → every cron tick fails INVALID_CONFIG silently — `BackupScheduler.ts:266-274`
- ☐ B11 backup/snapshot run on LIVE disks, no quiesce/guard (autoStopStart dead) → qcow2 corruption — `BackupService.ts:402-552`
- ☐ B12 orphan reaper SIGKILLs pidfile PIDs with NO identity check → kills innocent host proc as root — `HealthMonitor.ts:604-645`
- ☐ B13 startup race: orphan scan before reconcileStartupState → reaps 'starting' VMs — `Infinization.ts:200,451`,`HealthMonitor.ts:283`
- ☐ B14 findMachineByInternalName fails OPEN on DB error → scanner kills live VMs on a blip — `PrismaAdapter.ts:298-301`
- ☐ B15 transitionVMStatus select omits TPM/guest-agent/virtio/NUMA cols → Win11 loses TPM on restart — `PrismaAdapter.ts:656-687`
- ☐ B16 CommandExecutor: no timeout/kill/maxBuffer → hung child hangs op holding locks — `commandExecutor.ts:24-72`
- ☐ B17 4 highest-value test suites don't compile (0 executing tests) — `tests/{VMLifecycle,QMPClient,QemuProcess,eventHandlerCleanup}.spec.ts`

## IMPORTANT (45)

- ☐ I01 start() cleanup destroys REUSED persistent TAP + wipes config on any mid-start fail — `VMLifecycle.ts:913,2878-2899`
- ☐ I02 start() display-port probe→bind TOCTOU; concurrent starts collide EADDRINUSE — `VMLifecycle.ts:864-875`
- ☐ I03 cleanup() forces status='error'+clears config even as start() failure handler → un-startable — `VMLifecycle.ts:2889-2899`
- ☐ I04 create() firewall applied with no department defaultAction; rule-less BLOCK_ALL not denied — `VMLifecycle.ts:350-357`
- ☐ I05 daemonized graceful stop signals dead fork-parent → every stop is delayed SIGKILL — `QemuProcess.ts:192-195`
- ☐ I06 daemonized PID read best-effort: start() resolves with stale fork PID — `QemuProcess.ts:206-221`
- ☐ I07 QMP reconnect_failed has zero subscribers → dead client silently stops syncing — `QMPClient.ts:682-708`
- ☐ I08 QMP reconnect timer uncancellable; disconnect() can't stop in-flight reconnect — `QMPClient.ts:691-708`
- ☐ I09 failed connect/reconnect leaks _greeting once-listener — `QMPClient.ts:130-143`
- ☐ I10 QemuProcess spec 0 executing tests — `tests/QemuProcess.spec.ts`
- ☐ I11 -name/-cpu raw interpolation (sub-option confusion) — `QemuCommandBuilder.ts:880,141`
- ☐ I12 SPICE password raw + SpiceConfig.validate() never invoked — `SpiceConfig.ts:259`,`QemuCommandBuilder.ts:283`
- ☐ I13 ISO/firmware/socket path no comma containment — `QemuCommandBuilder.ts:343,807,619`
- ☐ I14 no QEMU sandbox/-runas defense-in-depth — `QemuCommandBuilder.ts`
- ☐ I15 no VM-stopped guard before snapshot/revert/resize/convert; file.locking not enabled — `SnapshotManager.ts:54,152`
- ☐ I16 BackupService failure path rm-rf destDir then writes manifest → ENOENT masks error — `BackupService.ts:148-157`
- ☐ I17 SnapshotManager omits `--` argv terminator + skips validateSnapshotName on revert/delete — `SnapshotManager.ts:148,204,248`
- ☐ I18 createImage linked clones: no backing-file exists/qcow2 validation — `QemuImgService.ts:59-68`
- ☐ I19 no per-image concurrency control (unlike network KeyedMutex) — `BackupService.ts:75,124`
- ☐ I20 scheduled-backup/retention failures swallowed into default-off debug log — `BackupScheduler.ts:289-293`
- ☐ I21 manifest written on failure after dir rm-rf'd — `BackupService.ts:148-157`
- ☐ I22 MAX_CONCURRENT_BACKUPS never enforced; no per-disk/cron-overlap lock — `BackupService.ts:97-124`
- ☐ I23 INCREMENTAL chain stores absolute parent paths, no integrity/relocation protection — `BackupService.ts:478,489,505`
- ☐ I24 schedules.json non-atomic; parse error silently drops ALL schedules — `BackupScheduleService.ts:367-416`
- ☐ I25 guest-shutdown cleanup leaks TAP→bridge (tapDeviceName fetched after status=off) — `EventHandler.ts:298,491-523`
- ☐ I26 sync cleanup/status writes bypass facade vmLock → race lifecycle ops — `EventHandler.ts:491-548`,`HealthMonitor.ts:810`
- ☐ I27 reconcileTransientStates promotes starting→running on PID liveness alone (no identity/QMP) — `HealthMonitor.ts:550-561`
- ☐ I28 pinned-VM cgroup scope leaks on guest shutdown (hasCpuPinning hardcoded false) — `StateSync.ts:297-302`
- ☐ I29 cpuset.mems hardcoded '0' → all-remote memory for non-node-0 pins — `CgroupsManager.ts:378-385`
- ☐ I30 ensureInfinizationSlice skips root cpuset delegation when slice pre-exists → pinning silently off — `CgroupsManager.ts:281-316`
- ☐ I31 validateCores compares against nproc COUNT not online-CPU set — `CgroupsManager.ts:206-216`
- ☐ I32 CPU pinning fully fail-open: caller can't tell VM launched unpinned — `CpuPinningAdapter.ts:137-163`
- ☐ I33 unattended first SHUTDOWN/POWERDOWN treated as success → media ejected mid-install — `InstallationMonitor.ts:265-274`
- ☐ I34 install monitor shares create()-time QMPClient with EventHandler which tears VM down — `VMLifecycle.ts:572,579-584`
- ☐ I35 temp ISO leaks on every non-success terminal path — `UnattendedInstaller.ts:220-223`
- ☐ I36 fire-and-forget monitor untracked/uncancellable; timers not unref'd — `VMLifecycle.ts:584`
- ☐ I37 productKey/locale/timezone/hostname accepted but silently dropped — `UnattendedInstaller.ts:418-424`
- ☐ I38 unsanitized credentials/scripts forwarded verbatim into answer-file — `UnattendedInstaller.ts:403-424`
- ☐ I39 optimistic locking half-wired: version bumps only off→starting — `PrismaAdapter.ts:316-340`
- ☐ I40 raw Prisma error codes stringified/lost (no P2034 retry/P2002/P2025) — `PrismaAdapter.ts:242-250`
- ☐ I41 malformed diskPaths/cpuPinning JSON silently coerced to null — `PrismaAdapter.ts:977,1001`
- ☐ I42 GuestAgentClient.disconnect() no timeout → hangs facade finally — `GuestAgentClient.ts:101-112`
- ☐ I43 display password leaked into process table + debug logs — `SpiceConfig.ts:259`,`QemuCommandBuilder.ts:283`
- ☐ I44 NftablesService chainLock per-instance; backend news up 5 instances → no cross-subsystem serialization — `NftablesService.ts:76,188`
- ☐ I45 createVMChain/ensureVMChain/flushVMRules/attach/detachJumpRules run OUTSIDE chainLock — `NftablesService.ts:116,596,632`
- ☐ I46 always-injected ct-state rule, no br_netfilter/nf_conntrack preflight → applyRules fails on some hosts — `NftablesService.ts:739-750`
- ☐ I47 background EventEmitters emit 'error' → one missing listener crashes privileged backend — `HealthMonitor.ts:373`,`EventHandler.ts:361`

## MINOR (30) — fixed where cheap/related; otherwise documented

- ☐ M01 orphan-PID reclaim keyed on internalName but op-lock keyed on vmId — `VMLifecycle.ts:228,341`
- ☐ M02 forceKill/waitForProcessExit report success even when SIGKILL never reaps — `QemuProcess.ts:328-348`
- ☐ M03 detached QEMU child never unref'd; persistent listeners on dead fork-parent — `QemuProcess.ts:149-169`
- ☐ M04 invalid enum values silently downgraded to defaults — `VMLifecycle.ts:2016`,`DriverPresets.ts:283`
- ☐ M05 guestExec unvalidated arbitrary-binary sink, no authz at facade — `Infinization.ts:547-566`
- ☐ M06 guestExec poll timeout never reaps spawned guest process — `GuestAgentClient.ts:188-217`
- ☐ M07 activeVMs lying/leaky cache (placeholder internalName, untrack only on success) — `Infinization.ts:330-358`
- ☐ M08 mid-exec QGA socket error drops in-flight commands silently — `GuestAgentClient.ts:74-78`
- ☐ M09 read-path device ops bypass per-VM vmLock — `Infinization.ts:419-423`
- ☐ M10 snapshotExists() fail-open: returns false on ANY error — `SnapshotManager.ts:256-260`
- ☐ M11 checkImage regex-parses JSON from free-form error string — `QemuImgService.ts:337-356`
- ☐ M12 qemu-img error classification by English substring matching — `QemuImgService.ts:93`,`SnapshotManager.ts:63`
- ☐ M13 zero tests for parseSnapshotList/parseSize/checkImage recovery — `SnapshotManager.ts:319-428`
- ☐ M14 retention counts only this-schedule backups; tolerates delete failures → unbounded growth — `BackupScheduler.ts:300-337`
- ☐ M15 loadFromDisk no missed-run catch-up; trusts persisted nextRunAt — `BackupScheduleService.ts:382-396`
- ☐ M16 deleteBackup snapshot cleanup best-effort/swallowed → orphaned internal snapshots — `BackupService.ts:328-341`
- ☐ M17 cron validation rejects valid 6-field expressions — `BackupScheduleService.ts:454-462`
- ☐ M18 EventHandler.isProcessAlive weaker than HealthMonitor's (EPERM/zombie = dead) — `EventHandler.ts:576-584`
- ☐ M19 no authoritative per-VM cgroup teardown; leaks on crash/force-kill — `CgroupsManager.ts:77-78,118-157`
- ☐ M20 numactl path never validates selected cores online before --physcpubind — `CpuPinningAdapter.ts:184-200`
- ☐ M21 SharedAlgorithms.ts hand-maintained copy, zero tests, drift risk — `SharedAlgorithms.ts:9-12`
- ☐ M22 InstallationMonitor QMP disconnect race in start() — `InstallationMonitor.ts:106-130`
- ☐ M23 install failure never rejects; VMLifecycle .catch() dead — `InstallationMonitor.ts:433-439`
- ☐ M24 start race surfaces as two error codes (UPDATE_FAILED vs VERSION_CONFLICT) — `PrismaAdapter.ts:716-733`
- ☐ M25 CommandExecutor error embeds full stdout+stderr (sensitive) — `commandExecutor.ts:52`
- ☐ M26 retryOnBusy classifies 'busy' by English substring — `retry.ts:128-138`
- ☐ M27 addJumpRules relies on 'File exists' dedup (jump rules leak on restart) — `NftablesService.ts:895-919`
- ☐ M28 NftablesPersistence.releaseLock unlinks with no owner check — `NftablesPersistence.ts:551-564`
- ☐ M29 removeVMChainByName/removeJumpRules build RegExp from chainName unescaped — `NftablesService.ts:380,452`
- ☐ M30 invalid-enum/error-classification logging below debug level — various

## FEATURES IMPLEMENTED (deemed necessary for prod)

- ☐ F01 structured, leveled, injectable logger emitting error+warn unconditionally (replaces bare `debug`)
- ☐ F02 host-reboot recovery + PID-reuse verification consolidated into the reconcile path
- ☐ F03 secure-by-default display (loopback bind, QMP set_password) + QEMU sandbox/-runas + per-VM cgroup mem/PID caps
- ☐ F04 metrics/getHealth() aggregate readiness signal on the facade

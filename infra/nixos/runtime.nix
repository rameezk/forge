{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.forge.runtime;

  harnessProviders = lib.importJSON ../../runtime/packages/runner/src/harness-providers.json;
  harnessEfforts = lib.importJSON ../../runtime/packages/runner/src/reasoning-efforts.json;
  allEfforts = lib.unique (lib.concatLists (lib.attrValues harnessEfforts));

  forgeGitShaVariable = lib.optional (cfg.gitSha != null) "FORGE_GIT_SHA=${cfg.gitSha}";

  timeSpanUnits = {
    s = 1;
    sec = 1;
    second = 1;
    seconds = 1;
    m = 60;
    min = 60;
    minute = 60;
    minutes = 60;
    h = 3600;
    hr = 3600;
    hour = 3600;
    hours = 3600;
    d = 86400;
    day = 86400;
    days = 86400;
    w = 604800;
    week = 604800;
    weeks = 604800;
  };
  maxTimeSpanSeconds = 2147483;
  timeSpanPart = "([0-9]+)[[:space:]]*([a-z]+)";
  timeSpanParts =
    value:
    if builtins.match "[[:space:]]*([0-9]+)[[:space:]]*" value != null then
      [
        [
          (lib.head (builtins.match "[[:space:]]*([0-9]+)[[:space:]]*" value))
          "s"
        ]
      ]
    else if builtins.match "[[:space:]]*(${timeSpanPart}[[:space:]]*)+" value != null then
      lib.filter builtins.isList (builtins.split timeSpanPart value)
    else
      [ ];
  timeSpanSeconds =
    value:
    lib.foldl' (total: part: total + lib.toInt (lib.elemAt part 0) * timeSpanUnits.${lib.elemAt part 1}) 0 (
      timeSpanParts value
    );
  isTimeSpan =
    value:
    let
      parts = timeSpanParts value;
    in
    parts != [ ] && lib.all (part: timeSpanUnits ? ${lib.elemAt part 1}) parts && timeSpanSeconds value > 0
    && timeSpanSeconds value <= maxTimeSpanSeconds;
  timeSpan = lib.types.addCheck lib.types.str isTimeSpan // {
    description = "systemd time span of whole seconds, minutes, hours, days or weeks, at most 2147483 seconds, just under 25 days, such as \"2h\" or \"1h 30min\"";
  };

  positiveNumber = lib.types.addCheck lib.types.number (value: value > 0) // {
    description = "positive number";
  };

  harnessModule = lib.types.submodule {
    options = {
      command = lib.mkOption {
        type = lib.types.strMatching "/.+";
        description = "Executable that runs this harness headlessly and emits its event stream. It must be an absolute path, and it is resolved to its real path before the workload sandbox starts, so it must resolve into the Nix store.";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Operator extra arguments for the harness, passed after the invocation the runner builds and before the prompt. The runner owns the harness's own CLI contract. The harness runs in the workload sandbox, so any path an argument names must be in the Nix store.";
      };
    };
  };

  workerModule = lib.types.submodule ({ config, ... }: {
    options = {
      harness = lib.mkOption {
        type = lib.types.str;
        description = "Name of the harness this worker binds to.";
      };
      model = lib.mkOption {
        type = lib.types.str;
        description = "Model the harness runs, as the provider addresses it.";
      };
      prompt = lib.mkOption {
        type = lib.types.lines;
        description = "Prompt the worker runs on. It must not start with `-` or `@`, which the harness would parse as an option or a file; the runner rejects such a worker.";
      };
      provider = lib.mkOption {
        type = lib.types.enum (lib.importJSON ../../runtime/packages/runner/src/providers.json);
        default = harnessProviders.${config.harness} or "openrouter";
        defaultText = lib.literalExpression ''the provider its harness takes, `openrouter` for pi and `anthropic` for claude-code, and `openrouter` for any other harness'';
        description = "Where this worker's model is served from, which its harness fixes: pi takes `openrouter` only and claude-code `anthropic` only, and a worker pairing a harness with the other provider is rejected. `openrouter` bills each generation. `anthropic` runs on the operator's Claude subscription, needs Anthropic's own model id and the `anthropic_oauth_token` secret, and is never billed.";
      };
      reasoningEffort = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum allEfforts
        );
        default = null;
        description = "Reasoning effort, or null to run at the provider default. Each harness takes its own levels: ${
          lib.concatStringsSep "; " (
            lib.mapAttrsToList (harness: levels: "${harness} ${lib.concatStringsSep ", " levels}") harnessEfforts
          )
        }. A worker whose effort its harness does not take is rejected.";
      };
      maxCost = lib.mkOption {
        type = lib.types.nullOr positiveNumber;
        default = cfg.workload.maxCost;
        defaultText = lib.literalExpression "config.forge.runtime.workload.maxCost";
        example = 2.5;
        description = "Most this worker's workload may spend, subagents included, as a positive number of USD, or null for unlimited. Spend is each generation's billed cost where known and its estimated cost otherwise, checked after every generation, so a workload can overshoot it by the generations in flight. A workload that passes it is hard-stopped and ends as exceeded, and one whose model's list price cannot be fetched at start is refused before it spends anything. Defaults to `forge.runtime.workload.maxCost`.";
      };
      timeout = lib.mkOption {
        type = lib.types.nullOr timeSpan;
        default = cfg.workload.timeout;
        defaultText = lib.literalExpression "config.forge.runtime.workload.timeout";
        example = "30min";
        description = "Longest this worker's workload may run, as a systemd time span of whole seconds, minutes, hours, days or weeks such as `\"2h\"`, or null for unlimited. It counts from the harness's start, so checkout and devShell setup do not use it, and a workload that passes it is hard-stopped, its subagents included, and ends as exceeded. Setup is bounded by `forge.runtime.workload.setupTimeout` instead. A scheduled run's systemd unit also stops 15 minutes past the setup timeout plus this timeout, as a backstop for a runner that hangs, and the run then ends interrupted; dispatched, revised and conflict-resolved workloads share one backstop from the setup timeout plus the longest timeout of the workers concerned, and none when any of them is unlimited. Defaults to `forge.runtime.workload.timeout`.";
      };
    };
  });

  repositoryModule = lib.types.submodule {
    options = {
      worker = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        visible = false;
        description = "Removed: name the worker per trigger with `on.ticket` instead. Setting it fails evaluation.";
      };
      github = lib.mkOption {
        type = lib.types.strMatching "[A-Za-z0-9-]+/[A-Za-z0-9._-]+";
        example = "rameezk/forge";
        description = "The repository on GitHub as `owner/name`, whose issues track its tickets.";
      };
      on.ticket = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "builder";
        description = "Worker that `forge-dispatch` runs against this repository's tickets, in a fresh clone of its default branch, or null to only poll its frontier. Its prompt is a template filled in for each ticket: `{repo}` becomes the repository's `owner/name`, `{issue}` the ticket's number and `{url}` its URL, and it must hold `{issue}` or `{url}`. A leading `/<name>` runs the checkout's skill of that name, and the dispatch fails if the checkout has none. If the checkout has a `flake.nix`, the workload runs in its flake's default devShell for the box's system: its variables apply over the box's locale and under forge's deliberate ones (the path of the GitHub token file, the OpenRouter credential, the git environment and pi's own), its path comes ahead of the workload toolset, and the dispatch fails if nix cannot print it, including when the flake has no `devShells.<system>.default`.";
      };
      on.feedback = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "reviser";
        description = "Worker that revises this repository's pull requests in a fresh clone of the pull request's head branch, or null to turn revisions off for the repository. The dispatch pass starts it when feedback on a pull request forge's App opened has been quiet for `forge.runtime.feedback.quietPeriod`, and `forge-revise` starts it by hand. Within a frontier poll of a maintainer leaving feedback on such a pull request, forge's App also adds a 👀 reaction to it to show forge has seen it. Its prompt is a template filled in for each pull request: `{repo}` becomes the repository's `owner/name`, `{pr}` the pull request's number, `{url}` its URL and `{branch}` its head branch, and it must hold `{pr}` or `{url}`. A leading `/<name>` runs the branch's skill of that name, and the revision fails before the harness starts if the branch has none. Skills, project instructions and the devShell come from the branch, as for `on.ticket`. The worker is told that a person reviews the pull request: it proceeds where the feedback settles a skill's confirmation, and otherwise asks its question as a reply on the pull request and ends its run at once. Budget and timeout come from the worker.";
      };
      on.conflict = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "resolver";
        description = "Worker that resolves merge conflicts on this repository's pull requests in a fresh clone of the pull request's head branch, or null to turn conflict resolutions off for the repository. `forge-resolve-conflicts` starts it by hand. Its prompt is a template filled in for each pull request as for `on.feedback`, and it must hold `{pr}` or `{url}`. A leading `/<name>` runs the branch's skill of that name, and the conflict resolution fails before the harness starts if the branch has none. Forge first trial-merges the default branch into the branch: a clean merge ends the conflict resolution ok without starting the worker. Otherwise the prompt ends with the pull request, the default branch, the sha it must merge and the files that conflicted. The conflict resolution is ok only once GitHub reports the pull request's head as containing that sha and not conflicting with it. Any other outcome leaves the pull request open and untouched. Budget and timeout come from the worker.";
      };
    };
  };

  runtimeConfig = {
    harnesses = lib.mapAttrs (_: h: { inherit (h) command args; }) cfg.harnesses;
    workers = lib.mapAttrs (
      _: w:
      {
        inherit (w) harness model prompt provider;
        timeoutSeconds = if w.timeout == null then null else timeSpanSeconds w.timeout;
        maxCostUsd = w.maxCost;
      }
      // lib.optionalAttrs (w.reasoningEffort != null) { inherit (w) reasoningEffort; }
    ) cfg.workers;
    repositories = lib.mapAttrs (
      _: r:
      { inherit (r) github; }
      // lib.optionalAttrs (r.on.ticket != null || r.on.feedback != null || r.on.conflict != null) {
        on = lib.filterAttrs (_: worker: worker != null) { inherit (r.on) ticket feedback conflict; };
      }
    ) cfg.repositories;
  }
  // {
    workload.setupTimeoutSeconds = timeSpanSeconds cfg.workload.setupTimeout;
  }
  // lib.optionalAttrs (hasDispatch || hasRevision || hasConflictResolution) {
    dispatch = {
      inherit (cfg.dispatch) maxConcurrent maxOpenPullRequests;
    };
  }
  // lib.optionalAttrs hasRevision {
    feedback.quietPeriodSeconds = timeSpanSeconds cfg.feedback.quietPeriod;
  };

  runtimeConfigFile = pkgs.writeText "forge-runtime.json" (builtins.toJSON runtimeConfig);

  hasWorkers = cfg.workers != { };
  hasRepositories = cfg.repositories != { };
  hasDashboard = hasWorkers || hasRepositories;
  dispatchedRepositories = lib.filterAttrs (_: r: r.on.ticket != null) cfg.repositories;
  hasDispatch = dispatchedRepositories != { };
  revisedRepositories = lib.filterAttrs (_: r: r.on.feedback != null) cfg.repositories;
  hasRevision = revisedRepositories != { };
  resolvedRepositories = lib.filterAttrs (_: r: r.on.conflict != null) cfg.repositories;
  hasConflictResolution = resolvedRepositories != { };

  backstopMarginSeconds = 15 * 60;
  backstopSeconds =
    w:
    if w.timeout == null then
      null
    else
      timeSpanSeconds cfg.workload.setupTimeout + timeSpanSeconds w.timeout + backstopMarginSeconds;
  startTimeout = seconds: lib.optionalAttrs (seconds != null) { TimeoutStartSec = seconds; };
  scheduledBackstops = lib.mapAttrs' (
    name: w:
    lib.nameValuePair "forge-runner@${name}" {
      overrideStrategy = "asDropin";
      path = lib.mkForce cfg.toolset;
      serviceConfig.TimeoutStartSec = backstopSeconds w;
    }
  ) (lib.filterAttrs (_: w: w.timeout != null) cfg.workers);
  dispatchingBackstops = map (r: backstopSeconds cfg.workers.${r.on.ticket}) (
    lib.attrValues dispatchedRepositories
  );
  dispatchBackstop =
    if lib.elem null dispatchingBackstops || dispatchingBackstops == [ ] then
      null
    else
      lib.foldl' lib.max 0 dispatchingBackstops;

  revisionBackstop =
    let
      backstops = map (r: backstopSeconds cfg.workers.${r.on.feedback}) (lib.attrValues revisedRepositories);
    in
    if lib.elem null backstops || backstops == [ ] then null else lib.foldl' lib.max 0 backstops;

  conflictResolutionBackstop =
    let
      backstops = map (r: backstopSeconds cfg.workers.${r.on.conflict}) (lib.attrValues resolvedRepositories);
    in
    if lib.elem null backstops || backstops == [ ] then null else lib.foldl' lib.max 0 backstops;

  hasPullRequestPlaceholder = prompt: lib.hasInfix "{pr}" prompt || lib.hasInfix "{url}" prompt;

  hasTicketPlaceholder = prompt: lib.hasInfix "{issue}" prompt || lib.hasInfix "{url}" prompt;

  removedGitIdentityAssertion = {
    assertion = cfg.dispatch.gitIdentity == null;
    message = "forge.runtime.dispatch.gitIdentity was removed: commits are authored by the GitHub App's bot, so drop the option";
  };

  removedMemoryMaxAssertion = {
    assertion = cfg.workload.memoryMax == null;
    message = "forge.runtime.workload.memoryMax was removed: workloads and the nix daemon now share one memory budget, so set forge.runtime.workload.sharedMemoryMax instead";
  };

  workerPairingAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: w:
      lib.optionals (harnessProviders ? ${w.harness}) [
        {
          assertion = w.provider == harnessProviders.${w.harness};
          message = "forge.runtime.workers.${name} pairs harness '${w.harness}' with provider '${w.provider}': harness '${w.harness}' only takes provider ${harnessProviders.${w.harness}}";
        }
      ]
      ++ lib.optionals (harnessEfforts ? ${w.harness} && w.reasoningEffort != null) [
        {
          assertion = lib.elem w.reasoningEffort harnessEfforts.${w.harness};
          message = "forge.runtime.workers.${name} reasoning effort '${w.reasoningEffort}' must be one of ${lib.concatStringsSep ", " harnessEfforts.${w.harness}} for harness '${w.harness}'";
        }
      ]
    ) cfg.workers
  );

  tzdataNames =
    let
      fields = line: lib.splitString " " line;
      nameOf =
        line:
        let
          f = fields line;
        in
        if builtins.elemAt f 0 == "Z" then
          [ (builtins.elemAt f 1) ]
        else if builtins.elemAt f 0 == "L" then
          [ (builtins.elemAt f 2) ]
        else
          [ ];
    in
    lib.concatMap nameOf (lib.splitString "\n" (builtins.readFile "${pkgs.tzdata}/share/zoneinfo/tzdata.zi"));

  dashboardTimeZoneAssertion = {
    assertion = lib.elem cfg.dashboard.timeZone tzdataNames;
    message = "forge.runtime.dashboard.timeZone is '${cfg.dashboard.timeZone}', which is not an IANA time zone in tzdata: use a name such as 'Africa/Johannesburg' or 'UTC'";
  };

  workerNameAssertions = lib.mapAttrsToList (name: _: {
    assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
    message = "forge.runtime.workers.${name} must have a name of only letters, digits, `_` and `-`: it names the unit instance forge-runner@${name} and its backstop drop-in";
  }) cfg.workers;

  removedWorkerAssertions = lib.mapAttrsToList (name: r: {
    assertion = r.worker == null;
    message = "forge.runtime.repositories.${name}.worker was removed: name the worker per trigger with forge.runtime.repositories.${name}.on.ticket instead";
  }) cfg.repositories;

  dispatchAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: r:
      let
        option = "forge.runtime.repositories.${name}.on.ticket";
        declared = cfg.workers ? ${r.on.ticket};
      in
      [
        {
          assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
          message = "forge.runtime.repositories.${name} declares on.ticket, so its name must use only letters, digits, `_` and `-`: it names the repository in forge-dispatch and its unit";
        }
        {
          assertion = declared;
          message = "${option} names undeclared worker '${r.on.ticket}'";
        }
        {
          assertion = !declared || hasTicketPlaceholder cfg.workers.${r.on.ticket}.prompt;
          message = "worker '${r.on.ticket}', named by ${option}, has no ticket placeholder: its prompt must hold {issue} or {url}";
        }
      ]
    ) dispatchedRepositories
  );

  revisionAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: r:
      let
        option = "forge.runtime.repositories.${name}.on.feedback";
        declared = cfg.workers ? ${r.on.feedback};
      in
      [
        {
          assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
          message = "forge.runtime.repositories.${name} declares on.feedback, so its name must use only letters, digits, `_` and `-`: it names the repository in forge-revise and its unit";
        }
        {
          assertion = declared;
          message = "${option} names undeclared worker '${r.on.feedback}'";
        }
        {
          assertion = !declared || hasPullRequestPlaceholder cfg.workers.${r.on.feedback}.prompt;
          message = "worker '${r.on.feedback}', named by ${option}, has no pull request placeholder: its prompt must hold {pr} or {url}";
        }
      ]
    ) revisedRepositories
  );

  conflictResolutionAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: r:
      let
        option = "forge.runtime.repositories.${name}.on.conflict";
        declared = cfg.workers ? ${r.on.conflict};
      in
      [
        {
          assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
          message = "forge.runtime.repositories.${name} declares on.conflict, so its name must use only letters, digits, `_` and `-`: it names the repository in forge-resolve-conflicts and its unit";
        }
        {
          assertion = declared;
          message = "${option} names undeclared worker '${r.on.conflict}'";
        }
        {
          assertion = !declared || hasPullRequestPlaceholder cfg.workers.${r.on.conflict}.prompt;
          message = "worker '${r.on.conflict}', named by ${option}, has no pull request placeholder: its prompt must hold {pr} or {url}";
        }
      ]
    ) resolvedRepositories
  );

  runtimeUser = config.users.users.${cfg.user};
  runtimeGroups = lib.unique (
    [ runtimeUser.group ]
    ++ lib.attrNames (lib.filterAttrs (_: group: lib.elem cfg.user group.members) config.users.groups)
  );
  runtimeTrustNames = [
    cfg.user
    "*"
  ]
  ++ map (group: "@${group}") runtimeGroups;

  trustedUsers =
    lib.concatMap
      (entry: lib.filter (name: lib.isString name && name != "") (builtins.split "[[:space:]]+" entry))
      (config.nix.settings.trusted-users ++ lib.toList (config.nix.settings.extra-trusted-users or [ ]));
  extraOptionsSetTrust = lib.any (
    line: builtins.match "[[:space:]]*(extra-)?trusted-users[[:space:]]*=.*" line != null
  ) (lib.splitString "\n" config.nix.extraOptions);

  untrustedAssertion = {
    assertion =
      !(lib.any (name: lib.elem name runtimeTrustNames) trustedUsers) && !extraOptionsSetTrust;
    message = "${cfg.user} must never be a trusted nix user, by name, by group or through a wildcard in nix.settings.trusted-users or nix.settings.extra-trusted-users, and nix.extraOptions must not set either, since evaluation cannot check it there: a trusted user can add unsigned paths and change substituters, so one workload could plant a tool for a later one through the store";
  };

  startableUnits =
    lib.optional hasDispatch "forge-dispatch@(?:${lib.concatStringsSep "|" (lib.attrNames dispatchedRepositories)})"
    ++ lib.optional hasRevision "forge-revise@(?:${lib.concatStringsSep "|" (lib.attrNames revisedRepositories)})"
    ++ lib.optional hasConflictResolution "forge-resolve-conflicts@(?:${lib.concatStringsSep "|" (lib.attrNames resolvedRepositories)})";
  startableUnitPattern = "^${
    if lib.length startableUnits == 1 then lib.head startableUnits else "(?:${lib.concatStringsSep "|" startableUnits})"
  }:[1-9][0-9]*\\.service$";

  reviseInstance = pkgs.writeShellScript "forge-revise-instance" ''
    exec ${cfg.package}/bin/forge-revise "''${1%:*}" "''${1##*:}"
  '';

  resolveConflictsInstance = pkgs.writeShellScript "forge-resolve-conflicts-instance" ''
    exec ${cfg.package}/bin/forge-resolve-conflicts "''${1%:*}" "''${1##*:}"
  '';

  dispatchInstance = pkgs.writeShellScript "forge-dispatch-instance" ''
    exec ${cfg.package}/bin/forge-dispatch "''${1%:*}" "''${1##*:}"
  '';

  usesAnthropic = lib.any (worker: worker.provider == "anthropic") (lib.attrValues cfg.workers);
  envFile = name: config.sops.templates.${name}.path;
  envTemplateOf = variables: {
    content = lib.concatMapStrings (
      { variable, secret }: "${variable}=${config.sops.placeholder.${secret}}\n"
    ) variables;
    owner = cfg.user;
    mode = "0400";
  };
  envTemplate = variable: secret: envTemplateOf [ { inherit variable secret; } ];
  openRouterKey = {
    variable = "OPENROUTER_API_KEY";
    secret = "openrouter_api_key";
  };

  appKeyCredentialId = "github-app-private-key";
  appKeyCredential = {
    LoadCredential = [ "${appKeyCredentialId}:${config.sops.secrets.github_app_private_key.path}" ];
  };
  appKeyFileVariable = "FORGE_GITHUB_APP_PRIVATE_KEY_FILE=%d/${appKeyCredentialId}";

  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ReadWritePaths = [ cfg.stateDir ];
    RestrictSUIDSGID = true;
    ProtectKernelTunables = true;
    ProtectControlGroups = true;
    InaccessiblePaths = [
      "/run/secrets"
      "/run/secrets.d"
    ];
  };

  tailnetAddresses = [
    "100.64.0.0/10"
    "fd7a:115c:a1e0::/48"
  ];

  workloadHardening = hardening // {
    ProtectKernelTunables = false;
    IPAddressDeny = tailnetAddresses;
  };

  workloadSlice = "forge-workloads.slice";

  workloadMemory = {
    Slice = workloadSlice;
    OOMPolicy = "continue";
  };

  baseToolset = [
    "bash"
    "coreutils"
    "findutils"
    "gnugrep"
    "gnused"
    "gawk"
    "diffutils"
    "gnutar"
    "gzip"
    "which"
    "git"
    "ripgrep"
    "jq"
    "curl"
  ];

  githubCli = pkgs.writeShellScriptBin "gh" ''
    if [ -n "''${FORGE_GITHUB_TOKEN_FILE-}" ]; then
      GH_TOKEN="$(< "$FORGE_GITHUB_TOKEN_FILE")" || exit 1
      export GH_TOKEN
    fi
    exec ${lib.getExe pkgs.gh} "$@"
  '';

  credentialToolsVariable = "FORGE_CREDENTIAL_TOOLS=${githubCli}/bin";
in
{
  options.forge.runtime = {
    user = lib.mkOption {
      type = lib.types.str;
      default = "forge-runtime";
      readOnly = true;
      description = "Dedicated service user that owns the runtime state and runs the runner.";
    };

    gitSha = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "The git revision of forge this host was built from, set for the runner and dispatch units as FORGE_GIT_SHA so each workload records it beside its config fingerprint. Null leaves the variable unset and workloads record no revision.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/forge";
      readOnly = true;
      description = "State directory owned by the runtime service user, holding the SQLite store, per-run transcripts and the records beside them, run directories, and the agent directories pi reads each run's model from. Run directories age out after 14 days, as do the agent directories; the SQLite store, transcripts and the records beside them are kept.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.forge-runner;
      defaultText = lib.literalExpression "pkgs.forge-runner";
      description = "Runtime package providing the forge-run, forge-dispatch, forge-revise, forge-resolve-conflicts, forge-dispatch-pass, forge-billing, forge-migrate, forge-frontier and forge-frontend entry points.";
    };

    dashboard.timeZone = lib.mkOption {
      type = lib.types.str;
      default = "UTC";
      example = "Africa/Johannesburg";
      description = "IANA time zone the dashboard shows every time in. Date filters and chart days stay UTC. The box, the store and all time logic stay UTC; hovering a time on the dashboard still shows its exact UTC instant.";
    };

    secretsFile = lib.mkOption {
      type = lib.types.path;
      description = "The operator's sops-encrypted runtime secrets file, decrypted on the box with its host key. It must hold `tailscale_auth_key` (the OAuth client secret the box joins the tailnet with as tag:forge) on every box, `openrouter_api_key` when any worker is declared, `anthropic_oauth_token` (a `claude setup-token` token, passed only to the runner) when any worker's provider is `anthropic`, and `github_app_id` and `github_app_private_key` (the id and private key of the operator's GitHub App, installed on every managed repository and on the operator repository) when any repository is declared or `pullDeploy.enable` is set. Only tailscaled-autoconnect reads `tailscale_auth_key`, from the decrypted file. No forge unit can see the decrypted secrets: each gets only what systemd reads for it, an EnvironmentFile or, for the App private key, a credential only the frontier sync, forge-dispatch and the pull deploy are given.";
    };

    dispatch.gitIdentity = lib.mkOption {
      type = lib.types.nullOr lib.types.attrs;
      default = null;
      visible = false;
      description = "Removed: commits are authored by the GitHub App's bot. Setting it fails evaluation.";
    };

    dispatch.maxConcurrent = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1;
      example = 2;
      description = "How many workloads may run at once, across every managed repository, whether dispatched by hand with `forge-dispatch` or by the dispatch pass that follows each frontier sync, or running a revision started with `forge-revise` or a conflict resolution started with `forge-resolve-conflicts`. Tickets from the same repository may run in parallel. A ticket over the limit stays `forge:ready` until a later pass finds a free slot, and a manual dispatch, revision or conflict resolution over it is refused. Workloads running at once share the memory budget, `forge.runtime.workload.sharedMemoryMax`.";
    };

    dispatch.maxOpenPullRequests = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = 5;
      example = 3;
      description = "The review limit: the most dispatches forge may have in flight or awaiting review across every managed repository, counting its running dispatches plus the open pull requests it opened for dispatches. At the limit the dispatch pass starts no new dispatch, logging each ticket that waits, and `forge-dispatch` refuses to start one, while revisions and conflict resolutions keep running. A pull request stops counting once the frontier sync records it as merged or closed. `null` turns the limit off.";
    };

    feedback.quietPeriod = lib.mkOption {
      type = timeSpan;
      default = "10min";
      example = "2min";
      description = "How long a pull request's newest feedback must have been quiet before the dispatch pass starts a revision for it, as a systemd time span of whole seconds, minutes, hours, days or weeks such as `\"10min\"`. Feedback that keeps arriving, a review and then a comment, becomes one revision. `forge-revise` skips it. A revision starts within roughly this period plus a frontier poll interval of feedback being left, but forge's App acknowledges the feedback with a 👀 reaction within one frontier poll interval.";
    };

    frontier.pollInterval = lib.mkOption {
      type = lib.types.str;
      default = "5min";
      example = "15min";
      description = "How often the frontier poller syncs the managed repositories' frontier from GitHub, as a systemd time span.";
    };

    pullDeploy = {
      enable = lib.mkEnableOption "the pull deploy: every `pullDeploy.intervalSeconds` seconds the box compares the commit at the head of its operator repository's `main` with the operator commit it runs and builds and switches to `main` when they differ, recording the commit it runs, the head and the last switch error in `pullDeploy.statusFile`. A commit that fails to build or switch is not tried again until `main` moves or the `forge-pull-deploy` unit is restarted by hand. The box reads the operator repository with the operator's GitHub App (`github_app_id` and `github_app_private_key`), through an installation token narrowed to that repository with read access to contents, so the App must be installed on it";

      repository = lib.mkOption {
        type = lib.types.strMatching "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
        example = "your-org/forge-operator";
        description = "The operator repository, as `owner/name`, whose `main` the box follows.";
      };

      remote = lib.mkOption {
        type = lib.types.str;
        default = "https://github.com/${cfg.pullDeploy.repository}.git";
        defaultText = lib.literalExpression ''"https://github.com/''${config.forge.runtime.pullDeploy.repository}.git"'';
        description = "The git remote the box clones the operator repository from. Only a test points it elsewhere.";
      };

      apiBase = lib.mkOption {
        type = lib.types.str;
        default = "https://api.github.com";
        description = "The GitHub API base the box mints its installation token from. Only a test points it elsewhere.";
      };

      intervalSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 300;
        description = "Seconds between two looks at the head of the operator repository's `main`. Only a test shortens it.";
      };

      statusFile = lib.mkOption {
        type = lib.types.path;
        default = "/var/lib/forge-pull-deploy/status.json";
        readOnly = true;
        description = "The deploy status the box records, a JSON object with `running` (the operator commit the box runs), `head` (the commit at the head of `main`) and `error` (the last switch error, or null), each null while unknown. The root-owned unit writes it into a root-owned directory and the dashboard only reads it.";
      };
    };

    workload.memoryMax = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      visible = false;
      description = "Removed: use `forge.runtime.workload.sharedMemoryMax`. Setting it fails evaluation.";
    };

    workload.sharedMemoryMax = lib.mkOption {
      type =
        lib.types.addCheck
          (lib.types.strMatching "[0-9]+|[0-9]+(\\.[0-9]+)?[KMGTPE]|[0-9]{1,2}(\\.[0-9]{1,2})?%|100(\\.0{1,2})?%|infinity")
          (value: builtins.match "[0.]+[KMGTPE%]?" value == null);
      default = "80%";
      example = "6G";
      description = "Memory every running workload, harness, subagents and commands included, and every build the nix daemon runs, deploy builds included, may use together, as a systemd `MemoryMax=` value: a size such as `6G`, or a percentage of the box's physical memory. The rest is kept for the box's own services. A workload or build that takes the budget past it has the largest process in the budget, in practice the runaway command or builder, killed by the kernel, and the agent sees that command exit with 137. Because the budget is shared, a workload can lose a command to another workload or build, and a deploy that builds while workloads are busy can fail (safe to re-run) or cause a workload's command to be killed. The box has no swap: size it for the heaviest set of workloads running at once with their builds.";
    };

    workload.maxCost = lib.mkOption {
      type = lib.types.nullOr positiveNumber;
      default = 5;
      example = 10;
      description = "Most a workload may spend unless its worker overrides it, subagents included, as a positive number of USD, or null for unlimited. Spend is each generation's billed cost where known and its estimated cost otherwise, checked after every generation, so a workload can overshoot it by the generations in flight. A workload that passes it is hard-stopped and ends as exceeded, and one whose model's list price cannot be fetched at start is refused before it spends anything; a dispatched one fails its dispatch and its ticket becomes `forge:failed` and gets forge's fixed failure comment.";
    };

    workload.timeout = lib.mkOption {
      type = lib.types.nullOr timeSpan;
      default = "2h";
      example = "30min";
      description = "Longest a workload may run unless its worker overrides it, as a systemd time span of whole seconds, minutes, hours, days or weeks, or null for unlimited. It counts from the harness's start, so setup is bounded by `forge.runtime.workload.setupTimeout` instead. A workload that passes it is hard-stopped, its subagents included, and ends as exceeded; a dispatched one fails its dispatch and its ticket becomes `forge:failed` and gets forge's fixed failure comment. Each systemd unit also stops 15 minutes past the setup timeout plus this timeout, as a backstop for a runner that hangs, and a run it kills ends interrupted.";
    };

    workload.setupTimeout = lib.mkOption {
      type = timeSpan;
      default = "30min";
      example = "1h";
      description = "Longest a workload's setup may take, as a systemd time span of whole seconds, minutes, hours, days or weeks. Setup is everything from the run starting to the harness starting: the clone, the checkout's skills and its devShell, plus a conflict resolution's trial merge, which runs before its run exists. It is global, with no per-worker or per-repository override, and it cannot be null, so setup is always bounded, even for a worker with no timeout. A setup that passes it is stopped, the child processes it started are killed, and the run ends as an error naming the limit and the stage that hung, never as exceeded, so the workload's own timeout does not count setup; a dispatch, revision or conflict resolution fails as errored, and a dispatched ticket becomes `forge:failed` and gets forge's fixed failure comment. A trial merge that passes it ends the conflict resolution failed as errored and leaves the pull request untouched. A repository whose cold devShell build takes longer needs this raised. It also sets each systemd backstop: the unit of a worker with a timeout stops 15 minutes past this plus that timeout.";
    };

    toolset = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = map (name: pkgs.${name}) baseToolset ++ [ config.nix.package ];
      defaultText = lib.literalExpression "with pkgs; [ ${lib.concatStringsSep " " baseToolset} ] ++ [ config.nix.package ]";
      example = lib.literalExpression "options.forge.runtime.toolset.default ++ [ pkgs.python3 ]";
      description = "Workload toolset: the packages that make up a workload's `PATH`. It is not a limit on what a workload can run, since the Nix store and the nix daemon are reachable from the sandbox (ADR-0024, ADR-0027). A dispatched workload whose checkout has a flake gets its devShell's path ahead of these. Forge's own `gh`, which reads the workload's GitHub token from its token file, is not part of the toolset: it is always present, ahead of the devShell and the toolset (ADR-0073). Extend the base set with `options.forge.runtime.toolset.default ++ [ ... ]`, or set a list to replace it.";
    };

    harnesses = lib.mkOption {
      type = lib.types.attrsOf harnessModule;
      default = { };
      description = "Available harnesses, keyed by the name workers reference.";
    };

    workers = lib.mkOption {
      type = lib.types.attrsOf workerModule;
      default = { };
      description = "Declared workers, keyed by name; declaring one makes it runnable on demand.";
    };

    repositories = lib.mkOption {
      type = lib.types.attrsOf repositoryModule;
      default = { };
      example = lib.literalExpression ''{ forge.github = "rameezk/forge"; }'';
      description = "Managed repositories, keyed by a short name; declaring one makes forge poll its frontier, show it on the dashboard, and put the forge-frontier command on the path to list it on demand.";
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      default = runtimeConfig;
      description = "Structured runtime config (harnesses, workers and repositories) the runtime reads.";
    };

    configFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = runtimeConfigFile;
      defaultText = lib.literalExpression "generated from forge.runtime.harnesses, forge.runtime.workers and forge.runtime.repositories";
      description = "Generated runtime config the runner reads to resolve a worker by name and the frontier poller reads to find the managed repositories.";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        removedGitIdentityAssertion
        removedMemoryMaxAssertion
        untrustedAssertion
        dashboardTimeZoneAssertion
      ]
      ++ workerNameAssertions
      ++ workerPairingAssertions
      ++ removedWorkerAssertions
      ++ dispatchAssertions
      ++ revisionAssertions
      ++ conflictResolutionAssertions;

      security.allowUserNamespaces = true;

      nix.settings.experimental-features = [
        "nix-command"
        "flakes"
      ];

      systemd.services.nix-daemon.serviceConfig = {
        IPAddressDeny = tailnetAddresses;
        Slice = workloadSlice;
        OOMPolicy = "continue";
      };

      systemd.slices.forge-workloads.sliceConfig.MemoryMax = cfg.workload.sharedMemoryMax;

      nix.gc = {
        automatic = true;
        dates = [ "weekly" ];
        options = "--delete-older-than 14d";
      };

      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.user;
        home = "/var/empty";
        description = "Forge runtime service user";
      };
      users.groups.${cfg.user} = { };

      systemd.tmpfiles.rules = [
        "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.user} - -"
        "d ${cfg.stateDir}/transcripts 0750 ${cfg.user} ${cfg.user} - -"
        "d ${cfg.stateDir}/work 0750 ${cfg.user} ${cfg.user} 14d -"
        "d ${cfg.stateDir}/agent 0750 ${cfg.user} ${cfg.user} 14d -"
      ];
    }

    { systemd.services = scheduledBackstops; }

    (lib.mkIf hasWorkers {
      sops.secrets = {
        openrouter_api_key.sopsFile = cfg.secretsFile;
      }
      // lib.optionalAttrs usesAnthropic {
        anthropic_oauth_token.sopsFile = cfg.secretsFile;
      };
      sops.templates = {
        "forge-billing.env" = envTemplateOf [ openRouterKey ];
        "forge-runner.env" = envTemplateOf (
          [ openRouterKey ]
          ++ lib.optional usesAnthropic {
            variable = "CLAUDE_CODE_OAUTH_TOKEN";
            secret = "anthropic_oauth_token";
          }
        );
      };

      systemd.services."forge-runner@" = {
        description = "Forge workload runner for worker %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        restartIfChanged = false;
        stopIfChanged = false;
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-runner.env";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            credentialToolsVariable
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${cfg.package}/bin/forge-run %i";
        }
        // workloadMemory
        // workloadHardening;
      };

      systemd.services.forge-billing = {
        description = "Forge billing: settle runs' billed cost from OpenRouter";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-billing.env";
          Environment = [ "FORGE_STATE_DIR=${cfg.stateDir}" ];
          ExecStart = "${cfg.package}/bin/forge-billing";
        }
        // hardening;
      };

      systemd.timers.forge-billing = {
        description = "Settle runs' billed cost";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1min";
          OnUnitActiveSec = "1min";
        };
      };
    })

    (lib.mkIf (hasRepositories || cfg.pullDeploy.enable) {
      sops.secrets.github_app_id.sopsFile = cfg.secretsFile;
      sops.secrets.github_app_private_key = {
        sopsFile = cfg.secretsFile;
        owner = cfg.user;
        mode = "0400";
      };
    })

    (lib.mkIf cfg.pullDeploy.enable {
      sops.templates."forge-pull-deploy.env" = {
        content = "FORGE_GITHUB_APP_ID=${config.sops.placeholder.github_app_id}\n";
        owner = "root";
        mode = "0400";
      };

      systemd.services.forge-pull-deploy = {
        description = "Forge pull deploy: switch to the operator repository's main whenever it moves";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        wantedBy = [ "multi-user.target" ];
        restartIfChanged = false;
        stopIfChanged = false;
        path = [ config.nix.package ];
        serviceConfig = {
          Type = "simple";
          Restart = "always";
          RestartSec = "10s";
          StateDirectory = "forge-pull-deploy";
          StateDirectoryMode = "0755";
          EnvironmentFile = envFile "forge-pull-deploy.env";
          Environment = [
            "FORGE_PULL_DEPLOY_REPOSITORY=${cfg.pullDeploy.repository}"
            "FORGE_PULL_DEPLOY_REMOTE=${cfg.pullDeploy.remote}"
            "FORGE_PULL_DEPLOY_API=${cfg.pullDeploy.apiBase}"
            "FORGE_PULL_DEPLOY_HOSTNAME=${config.networking.hostName}"
            "FORGE_PULL_DEPLOY_INTERVAL=${toString cfg.pullDeploy.intervalSeconds}"
            "FORGE_PULL_DEPLOY_STATUS_FILE=${cfg.pullDeploy.statusFile}"
            "HOME=/var/lib/forge-pull-deploy"
            appKeyFileVariable
          ];
          ExecStart = lib.getExe (pkgs.callPackage ../nix/pull-deploy-command.nix { });
        }
        // appKeyCredential;
      };
    })

    (lib.mkIf hasRepositories {
      sops.templates."forge-github-app.env" = envTemplate "FORGE_GITHUB_APP_ID" "github_app_id";

      environment.systemPackages = [
        (pkgs.callPackage ../nix/frontier-command.nix {
          forge-runner = cfg.package;
          inherit (cfg) configFile user;
          githubAppIdFile = envFile "forge-github-app.env";
          githubAppPrivateKeyFile = config.sops.secrets.github_app_private_key.path;
        })
      ];

      systemd.services.forge-frontier-sync = {
        description = "Forge frontier sync from GitHub";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-github-app.env";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            appKeyFileVariable
          ];
          ExecStart = "${cfg.package}/bin/forge-frontier sync";
        }
        // appKeyCredential
        // hardening;
      };

      systemd.timers.forge-frontier-sync = {
        description = "Poll the managed repositories' frontier";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1min";
          OnUnitActiveSec = cfg.frontier.pollInterval;
        };
      };
    })

    (lib.mkIf (hasWorkers && (hasDispatch || hasRevision || hasConflictResolution)) {
      security.polkit.enable = true;
      security.polkit.extraConfig = ''
        polkit.addRule(function (action, subject) {
          if (
            action.id == "org.freedesktop.systemd1.manage-units" &&
            subject.user == "${cfg.user}" &&
            action.lookup("verb") == "start" &&
            /${startableUnitPattern}/.test(action.lookup("unit"))
          ) {
            return polkit.Result.YES;
          }
        });
      '';

      systemd.services.forge-frontier-sync = {
        wants = [ "forge-dispatch-pass.service" ];
        before = [ "forge-dispatch-pass.service" ];
      };

      systemd.services.forge-dispatch-pass = {
        description = "Forge dispatch pass: start a forge-dispatch@ unit for each forge:ready frontier ticket and a forge-revise@ unit for each pull request whose feedback has gone quiet, up to dispatch.maxConcurrent";
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            "FORGE_SYSTEMCTL=${config.systemd.package}/bin/systemctl"
          ];
          ExecStart = "${cfg.package}/bin/forge-dispatch-pass";
          RestrictAddressFamilies = [ "AF_UNIX" ];
          IPAddressDeny = "any";
          PrivateNetwork = true;
          PrivateDevices = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectClock = true;
          ProtectHostname = true;
          RestrictNamespaces = true;
          LockPersonality = true;
          CapabilityBoundingSet = "";
          SystemCallArchitectures = "native";
          SystemCallFilter = [ "@system-service" ];
        }
        // hardening;
      };
    })

    (lib.mkIf (hasWorkers && hasDispatch) {
      environment.systemPackages = [
        (pkgs.callPackage ../nix/dispatch-command.nix { })
      ];

      systemd.services."forge-dispatch@" = {
        description = "Forge dispatch of ticket %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        restartIfChanged = false;
        stopIfChanged = false;
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = [
            (envFile "forge-runner.env")
            (envFile "forge-github-app.env")
          ];
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            credentialToolsVariable
            appKeyFileVariable
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${dispatchInstance} %i";
        }
        // startTimeout dispatchBackstop
        // workloadMemory
        // appKeyCredential
        // workloadHardening;
      };
    })

    (lib.mkIf (hasWorkers && hasRevision) {
      environment.systemPackages = [
        (pkgs.callPackage ../nix/revise-command.nix { })
      ];

      systemd.services."forge-revise@" = {
        description = "Forge revision of pull request %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        restartIfChanged = false;
        stopIfChanged = false;
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = [
            (envFile "forge-runner.env")
            (envFile "forge-github-app.env")
          ];
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            credentialToolsVariable
            appKeyFileVariable
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${reviseInstance} %i";
        }
        // startTimeout revisionBackstop
        // workloadMemory
        // appKeyCredential
        // workloadHardening;
      };
    })

    (lib.mkIf (hasWorkers && hasConflictResolution) {
      environment.systemPackages = [
        (pkgs.callPackage ../nix/resolve-conflicts-command.nix { })
      ];

      systemd.services."forge-resolve-conflicts@" = {
        description = "Forge conflict resolution of pull request %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        restartIfChanged = false;
        stopIfChanged = false;
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = [
            (envFile "forge-runner.env")
            (envFile "forge-github-app.env")
          ];
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            credentialToolsVariable
            appKeyFileVariable
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${resolveConflictsInstance} %i";
        }
        // startTimeout conflictResolutionBackstop
        // workloadMemory
        // appKeyCredential
        // workloadHardening;
      };
    })

    (lib.mkIf hasDashboard {
      environment.systemPackages = [ pkgs.sqlite ];

      systemd.services.forge-migrate = {
        description = "Forge store migration: bring forge.db to the current schema before the dashboard reads it";
        wantedBy = [ "multi-user.target" ];
        restartTriggers = [ cfg.package ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          Environment = [ "FORGE_STATE_DIR=${cfg.stateDir}" ];
          ExecStart = "${cfg.package}/bin/forge-migrate";
        }
        // hardening;
      };

      systemd.services.forge-frontend = {
        description = "Forge read-only workload dashboard (unix socket only)";
        wantedBy = [ "multi-user.target" ];
        after = [
          "network.target"
          "forge-migrate.service"
        ];
        requires = [ "forge-migrate.service" ];
        serviceConfig = {
          Type = "exec";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          Environment = [
            "FORGE_STATE_DIR=${cfg.stateDir}"
            "FORGE_FRONTEND_SOCKET=/run/forge-frontend/dashboard.sock"
            "FORGE_DASHBOARD_TIME_ZONE=${cfg.dashboard.timeZone}"
            "FORGE_MAX_CONCURRENT=${toString cfg.dispatch.maxConcurrent}"
          ];
          ExecStart = "${cfg.package}/bin/forge-frontend";
          Restart = "on-failure";

          RuntimeDirectory = "forge-frontend";
          RuntimeDirectoryMode = "0700";
          PrivateNetwork = true;
          RestrictAddressFamilies = [ "AF_UNIX" ];
          IPAddressDeny = "any";
        }
        // hardening
        // {
          ReadOnlyPaths = [ "${cfg.stateDir}/transcripts" ];
          InaccessiblePaths = hardening.InaccessiblePaths ++ [
            "${cfg.stateDir}/work"
            "${cfg.stateDir}/agent"
          ];
        };
      };
    })

    (lib.mkIf (hasDashboard && config.services.tailscale.enable) {
      systemd.services.forge-frontend-tailnet = {
        description = "Serve the Forge dashboard over HTTPS on the tailnet";
        wantedBy = [ "multi-user.target" ];
        after = [
          "tailscaled-autoconnect.service"
          "forge-frontend.service"
        ];
        wants = [
          "tailscaled-autoconnect.service"
          "forge-frontend.service"
        ];
        serviceConfig = {
          Type = "exec";
          ExecStart = "${lib.getExe config.services.tailscale.package} serve --https=443 unix:/run/forge-frontend/dashboard.sock";
          Restart = "always";
          RestartSec = "5s";
          CapabilityBoundingSet = "";
          RestrictAddressFamilies = [ "AF_UNIX" ];
          IPAddressDeny = "any";
        }
        // removeAttrs hardening [ "ReadWritePaths" ];
      };
    })
  ];
}

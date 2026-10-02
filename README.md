# <img src="docs/assets/logo.svg" alt="" height="44" align="top"> Forge

> A declarative software factory.

Forge runs agent workloads on a machine you define declaratively.

You declare **workers** in Nix, each binding a harness (such as `pi`) to a model and a prompt, and the **managed repositories** whose tickets they work on.

Forge stands up a NixOS box to run them on, and every run of a worker is an isolated **workload**.

Forge records each workload's transcript, token usage and billed cost, and shows them on a dashboard, so you can trace what every worker did and feed that back into improving your workers. The dashboard also shows the **frontier** of each managed repository: the tickets ready for an agent to pick up now.

## How it works

### Around Forge

Forge sits between the operator, the provider that hosts the box, and the model provider its workloads call.

```mermaid
flowchart TB
    operator["<b>Operator</b><br/>[Human]<br/>Declares Forge (workers etc)"]
    forge["<b>Forge</b><br/>[Software system]<br/>Runs agent workloads in isolation on a NixOS box"]
    hetzner["<b>Hetzner Cloud</b><br/>[External system]<br/>Hosts the box"]
    openrouter["<b>OpenRouter</b><br/>[External system]<br/>Serves models and bills each generation"]
    github["<b>GitHub</b><br/>[External system]<br/>Managed repositories and their tickets"]

    operator -- "stands up, deploys and watches" --> forge
    forge -- "provisions the server" --> hetzner
    forge -- "calls models, looks up billed cost" --> openrouter
    forge -- "polls the frontier, works tickets" --> github

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef system fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    class operator person
    class forge system
    class hetzner,openrouter,github external
```

### Inside Forge

The operator repository stands the box up with the standup toolchain. On the box:

- a runner runs each workload
- a billing service settles each run's billed cost
- a frontier service polls each managed repository's frontier
- a dashboard, served only on your tailnet, shows what they record

```mermaid
flowchart TB
    operator["<b>Operator</b><br/>[Human]"]

    subgraph workstation["Operator"]
        oprepo["<b>Operator repository</b><br/>[Nix flake]<br/>config.json, workers, standup commands"]
        toolchain["<b>Standup toolchain</b><br/>[OpenTofu, nixos-anywhere, nixos-rebuild]<br/>Provisions, installs and deploys the box"]
    end

    subgraph box["Forge box [NixOS]"]
        frontend["<b>forge-frontend</b><br/>[Node.js]<br/>Read-only dashboard on localhost"]
        state[("<b>State</b><br/>[SQLite, files]<br/>/var/lib/forge: runs, transcripts and the frontier")]
        runner["<b>forge-runner@worker</b><br/>[Node.js]<br/>Runs one workload, sandboxed"]
        harness["<b>Harness</b><br/>[pi CLI]<br/>Agent runtime for the workload"]
        billing["<b>forge-billing</b><br/>[Node.js, systemd timer]<br/>Settles billed cost, sandboxed"]
        frontier["<b>forge-frontier-sync</b><br/>[Node.js, systemd timer]<br/>Polls the frontier, sandboxed"]
    end

    library["<b>Forge library</b><br/>[Nix flake]<br/>Host builder, config loader, toolchain"]
    hetzner["<b>Hetzner Cloud</b><br/>[External system]"]
    openrouter["<b>OpenRouter</b><br/>[External system]"]
    github["<b>GitHub</b><br/>[External system]"]

    operator -- "edits" --> oprepo
    operator -- "views over the tailnet" --> frontend
    oprepo -- "consumes as a flake input" --> library
    oprepo -- "runs" --> toolchain
    toolchain -- "provisions the server" --> hetzner
    toolchain -- "installs and deploys NixOS over SSH" --> box
    frontend -- "reads" --> state
    runner -- "records runs and transcripts" --> state
    runner -- "spawns" --> harness
    harness -- "calls models" --> openrouter
    billing -- "looks up billed cost" --> openrouter
    billing -- "records billed cost" --> state
    frontier -- "polls the frontier" --> github
    frontier -- "records the frontier" --> state

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef container fill:#438dd5,stroke:#2e6295,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    classDef boundary fill:none,stroke:#888888,stroke-dasharray:6 4
    class operator person
    class oprepo,toolchain,library,runner,harness,billing,frontier,frontend,state container
    class hetzner,openrouter,github external
    class workstation,box boundary
```

### A workload run

```mermaid
sequenceDiagram
    participant R as forge-runner@worker
    participant S as Run store (SQLite)
    participant T as Transcript (file)
    participant H as Harness (pi)
    participant O as OpenRouter
    participant B as forge-billing (every minute)

    R->>O: look up the model's list price
    O-->>R: list price, or none if the lookup fails
    R->>S: record the run as running with its list price, cost pending
    R->>H: spawn with the worker's model and prompt
    loop each generation
        H->>O: model request
        O-->>H: response and generation id
        H-->>R: JSON event
        R->>T: append the event
        R->>S: record the generation id, its tokens and its estimated cost
    end
    H-->>R: exit
    R->>S: finalize the run with its status
    loop until every generation is billed, or given up after 24 hours
        B->>S: read unbilled generations
        B->>O: look up what each generation billed
        O-->>B: billed cost, or not indexed yet
        B->>S: replace estimates with billed costs and settle the run's cost status
    end
```

## Get started

Scaffold an operator repository:

```bash
nix flake init -t github:rameezk/forge
```

Then follow the scaffolded repository's [README](templates/operator/README.md) to generate secrets, stand up the box, deploy workers and open the dashboard.

## Learn more

- [`docs/CONTEXT.md`](docs/CONTEXT.md) - the shared language
- [`docs/adr/`](docs/adr) - the key decisions behind Forge and why they were made

## Why the name Forge

Forge is named after [Forge](https://en.wikipedia.org/wiki/Forge_(Marvel_Comics)), the Marvel mutant whose power is an intuitive genius for inventing machines.

> _"It always starts with a problem. An impractical, unattainable, unworkable problem that needs to be solved. Then... I solve it. I work it. I attain it. I move and shift and reshape. Make something out of nothing."_
>
> <sub>Forge, in [_Extraordinary X-Men_ #18](https://marvel.fandom.com/wiki/Extraordinary_X-Men_Vol_1_18)</sub>

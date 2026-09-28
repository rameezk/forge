# Forge

> A declarative software factory.
>
> <sub>Named after the Marvel mutant [Forge](https://en.wikipedia.org/wiki/Forge_(Marvel_Comics)), whose power is an intuitive genius for inventing machines.</sub>

Forge runs agent workloads on a machine you define declaratively.

You declare **workers** in Nix, each binding a harness (such as `pi`) to a model and a prompt.

Forge stands up a NixOS box to run them on, and every run of a worker is an isolated **workload**.

Forge records each workload's transcript, token usage and billed cost, and shows them on a dashboard, so you can trace what every worker did and feed that back into improving your workers.

## How it works

> [!NOTE]
> Dashed edges are planned and not built yet.

### System context

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
    forge -. "polls the frontier, works tickets (planned)" .-> github

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef system fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    class operator person
    class forge system
    class hetzner,openrouter,github external
```

### Containers

The operator repository stands the box up with the standup toolchain. On the box, the runner runs each workload and a localhost-only dashboard reads what it recorded.

```mermaid
flowchart TB
    operator["<b>Operator</b><br/>[Human]"]

    subgraph workstation["Operator"]
        oprepo["<b>Operator repository</b><br/>[Nix flake]<br/>config.json, workers, standup commands"]
        toolchain["<b>Standup toolchain</b><br/>[OpenTofu, nixos-anywhere, nixos-rebuild]<br/>Provisions, installs and deploys the box"]
    end

    subgraph box["Forge box [NixOS]"]
        frontend["<b>forge-frontend</b><br/>[Node.js]<br/>Read-only dashboard on localhost"]
        state[("<b>State</b><br/>[SQLite, files]<br/>/var/lib/forge: runs and transcripts")]
        runner["<b>forge-runner@worker</b><br/>[Node.js]<br/>Runs one workload, sandboxed"]
        harness["<b>Harness</b><br/>[pi CLI]<br/>Agent runtime for the workload"]
    end

    library["<b>Forge library</b><br/>[Nix flake]<br/>Host builder, config loader, toolchain"]
    hetzner["<b>Hetzner Cloud</b><br/>[External system]"]
    openrouter["<b>OpenRouter</b><br/>[External system]"]
    github["<b>GitHub</b><br/>[External system]"]

    operator -- "edits" --> oprepo
    operator -- "views over an SSH tunnel" --> frontend
    oprepo -- "consumes as a flake input" --> library
    oprepo -- "runs" --> toolchain
    toolchain -- "provisions the server" --> hetzner
    toolchain -- "installs and deploys NixOS over SSH" --> box
    frontend -- "reads" --> state
    runner -- "records runs and transcripts" --> state
    runner -- "spawns" --> harness
    harness -- "calls models" --> openrouter
    runner -- "looks up billed cost" --> openrouter
    runner -. "polls the frontier, works tickets (planned)" .-> github

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef container fill:#438dd5,stroke:#2e6295,color:#fff
    classDef external fill:#999999,stroke:#6b6b6b,color:#fff
    classDef boundary fill:none,stroke:#888888,stroke-dasharray:6 4
    class operator person
    class oprepo,toolchain,library,runner,harness,frontend,state container
    class hetzner,openrouter,github external
    class workstation,box boundary
```

### A workload run

One run of a worker, from start to its recorded billed cost.

```mermaid
sequenceDiagram
    participant R as forge-runner@worker
    participant S as Run store (SQLite)
    participant T as Transcript (file)
    participant H as Harness (pi)
    participant O as OpenRouter

    R->>S: record the run as running
    R->>H: spawn with the worker's model and prompt
    loop each generation
        H->>O: model request
        O-->>H: response and generation id
        H-->>R: JSON event
        R->>T: append the event
    end
    H-->>R: exit
    R->>O: look up what each generation billed
    O-->>R: billed cost
    R->>S: finalize the run with status, tokens and billed cost
```

## Get started

1. Scaffold an operator repository:

   ```bash
   nix flake init -t github:rameezk/forge
   ```

2. Fill in `config.json` from `config.example.json` with your SSH key, hostname and server, and add your Hetzner token to `.env`.
3. Create the box with `just standup`, then place your OpenRouter key on it.
4. Declare workers in `flake.nix` and apply them with `just deploy`, which keeps the box's state.
5. Open the dashboard over an SSH tunnel with `ssh -L 7787:localhost:7787 forge@<address>`, then browse to `http://localhost:7787`.

The scaffolded repository's README walks through each step in full.

## Learn more

- [`docs/CONTEXT.md`](docs/CONTEXT.md) - the shared language
- [`docs/adr/`](docs/adr) - the key decisions behind Forge and why they were made

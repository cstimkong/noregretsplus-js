
## The reimplemented NoRegrets+

This repository contains the reimplemented breaking change detection tool NoRegrets+ (fully written in JavaScript), introduced in the paper:


- Møller, Anders, and Martin Toldam Torp. "Model-based testing of breaking changes in Node. js libraries." Proceedings of the 2019 27th ACM joint meeting on european software engineering conference and symposium on the foundations of software engineering. 2019.

The original tool is [here](https://github.com/cs-au-dk/noregrets).

## Usage

### Generate API Model

Run the following command:

```
node generatemodel.js --library <library path> --client <client path> [--output <output path>] [--compress] [--mocha]
```

The output model contains paths and ρ-relations, stored in a JSON file.

### Type Regression Test

Run the following command:

```
node regression.js --library <library path> --model <model path> [--output <output path>]
```
# Lanzer
> An agent-driven Fuzzer for Langium based DSL

## What is Lanzer
Lanzer is a semiformal DSL and tools around it, for generating samples, for your DSL.
The DSL is used as a specifications for the tests you want to generate, with formal constraints imposed on the output, and informal description of what the text should do.

```
import "mylang.langium"

campaign sortingDemo {
  description "Sort an array of integers."
  workspace "test/test-cases/hello-world"

  file sortFile at "src/sort.tc" generates Module {
    require FnDecl[name="sort"]
    require FnDecl[name="partition"]
    min 2 FnDecl
  }

  file mainFile at "src/main.tc" generates Module {
    require FnDecl[name="main"]
    require FnDecl[name="main"] >> FunctionCall
    forbid FnDecl[name="eval"]
  }
}
```


## How it works
`Lanzer` allows you generate positive samples, for your DSL, it can be used for a variety of cases ranging from stress testing language implementation (and your runtime potentially), generating code examples or even testing your DSL agent skill.

The CLI allows you to use any coding agent you have installed, to generate code, making sure that the generated output is not only a valid document, but also adheres to the fixture.

## Requirements
To leverage lanzer, you need:
- Fully functional langium-based DSL implementation (with validations too).
- An ACP compatible coding agent (claude code, codex, gemini cli, etc)
- An agent skill for your DSL (see more on how to generate an agent skill for your dsl here. TODO: Link langium AI)
- Override services required by Lanzer, and specify any additional prompts or info you may need.



# langium-lox — Grammar Reference

Distilled from `packages/langium-lox/langium/src/language-server/lox.langium`. This is the
authoritative source; if anything here disagrees with that file, the file wins.

## Program structure

A program is a sequence of **LoxElement**s at the top level (no enclosing `main`):

```
LoxProgram      ::= LoxElement*

LoxElement      ::= Class
                  | ExpressionBlock          // a bare `{ ... }` block
                  | IfStatement
                  | WhileStatement
                  | ForStatement
                  | FunctionDeclaration
                  | VariableDeclaration ';'
                  | PrintStatement ';'
                  | ReturnStatement ';'
                  | Expression ';'           // bare expression statement
```

Note which forms take a trailing `;`: `var`, `print`, `return`, and bare expressions. Blocks,
`if`/`while`/`for`, `fun`, and `class` do **not**.

## Statements

```
IfStatement     ::= 'if' '(' Expression ')' ExpressionBlock ('else' ExpressionBlock)?
WhileStatement  ::= 'while' '(' Expression ')' ExpressionBlock
ForStatement    ::= 'for' '(' VariableDeclaration? ';' Expression? ';' Expression? ')' ExpressionBlock
PrintStatement  ::= 'print' Expression
ReturnStatement ::= 'return' Expression?
ExpressionBlock ::= '{' LoxElement* '}'
```

- `if`/`else`, `while`, and `for` bodies are **always** an `ExpressionBlock` (`{ ... }`). There is
  no single-statement body and no parentheses-less form.
- `for` clauses are all optional but the two `;` separators are required: `for ( ; ; ) { }` is legal.
- `return;` with no value is allowed by the grammar (only valid in a `void` function — see semantics).

## Declarations

```
VariableDeclaration ::= 'var' ID (':' TypeReference)? ('=' Expression)?
FunctionDeclaration ::= 'fun' ID '(' (Parameter (',' Parameter)*)? ')' ':' TypeReference ExpressionBlock
Parameter           ::= ID ':' TypeReference
```

- A `var` may have a type, a value, or both — but not neither (validator error otherwise).
- Function **parameters and return type are mandatory and typed**. The body is a brace block.
- Functions may be declared at the top level or nested inside blocks/functions (closures).

## Classes

```
Class        ::= 'class' ID ('<' superClassRef)? '{' ClassMember* '}'
ClassMember  ::= MethodMember | FieldMember
MethodMember ::= ID '(' (Parameter (',' Parameter)*)? ')' ':' TypeReference ExpressionBlock
FieldMember  ::= ID ':' TypeReference
```

`<` denotes inheritance. A field is `ID ':' Type` (no `var`, no `;`); a method is a function
signature without `fun`. Classes, fields, methods, `this`, and `super` validate and run — see
`semantics.md` for construction (`ClassName()`) and dispatch semantics.

## Expressions and precedence

Precedence from lowest to highest (each rule binds tighter than the one above):

```
Expression   ::= Assignment
Assignment   ::= Addition       ( '=' Addition )*
Addition     ::= Multiplication ( ('+' | '-') Multiplication )*
Multiplication ::= Logical      ( ('*' | '/') Logical )*
Logical      ::= Comparison     ( ('and' | 'or') Comparison )*
Comparison   ::= MemberCall     ( ('<'|'<='|'>'|'>='|'=='|'!=') MemberCall )*
MemberCall   ::= Primary ( '.' member callOrAccess | callArgs )*
Primary      ::= '(' Expression ')'
               | UnaryExpression
               | StringExpression | BooleanExpression | NumberExpression | NilExpression
               | FeatureCall
UnaryExpression ::= ('!' | '-' | '+') Expression
```

Caveats baked into this precedence table (it is unusual):

- **Assignment is parsed as a left-associative binary operator** at the lowest precedence. `a = b`
  is a `BinaryExpression` with operator `=`. The left side must be assignable (a variable / member).
- **`and`/`or` bind *tighter* than the comparison operators** here (Logical is above Comparison),
  which is the opposite of most languages. Parenthesize to be safe and explicit.
- `*` and `/` only — **no `%`** and no exponentiation operator exist in the grammar.

## Member access and calls

```
FeatureCall  ::= (ID | 'this' | 'super') callArgs?
MemberCall   ::= Primary ( '.' ID callArgs? | callArgs )*
callArgs     ::= '(' (Expression (',' Expression)*)? ')'
```

- Function calls: `f(a, b)`. Calls can chain on the result: `pickAdd()(1, 2)`.
- Member access `obj.field` / `obj.method(...)` exists in the grammar but only matters for classes,
  which don't run. `this`/`super` likewise only appear in class context.

## Types

```
TypeReference   ::= ClassRef
                  | 'string' | 'number' | 'boolean' | 'void'
                  | '(' (LambdaParameter (',' LambdaParameter)*)? ')' '=>' TypeReference
LambdaParameter ::= (ID ':')? TypeReference
```

- Primitives: `string`, `number`, `boolean`, `void`.
- Function types: `(number, number) => number`, `() => void`, `(string) => boolean`. Parameter
  names in a function type are optional: `(a: number) => number` and `(number) => number` are equivalent.
- A type can also be a class name (only meaningful if classes worked).

## Terminals

```
WS          : /\s+/                       (hidden)
ID          : /[_a-zA-Z][\w_]*/
NUMBER      : /[0-9]+(\.[0-9]+)?/          (no leading sign; '-' is the unary operator)
STRING      : /"[^"]*"/                    (double quotes only; no escapes, no embedded ")
ML_COMMENT  : /\/\*[\s\S]*?\*\//           (hidden)
SL_COMMENT  : /\/\/[^\n\r]*/               (hidden)

Keyword literals: var fun class if else while for print return
                  true false nil and or this super
                  string number boolean void
```

- Numbers have no sign and no exponent form; negative values are `-` applied as a unary operator.
- Strings cannot contain a `"` and have no escape sequences — `"\n"` is a literal backslash-n.

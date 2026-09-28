grammar Shapes

entry Doc:
    items+=(Var | Fun)*;

Var returns Named:
    {infer Var} 'var' name=ID ('=' value=Expr)?;

Fun returns Named:
    {infer Fun} 'fun' name=ID '{' body+=(Var | Fun)* '}';

type Named = Var | Fun;

Expr:
    Add;

Add infers Expr:
    Primary ({infer Add.left=current} '+' right=Primary)*;

Primary infers Expr:
    {infer Num} value=NUMBER | {infer Ref} target=[Named:ID];

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+/;

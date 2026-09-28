grammar Mini

entry Module:
    (functions+=Fn | classes+=Cls)*;

Fn:
    'fn' name=ID '(' (params+=Param (',' params+=Param)*)? ')' '{' body+=Stmt* '}';

Param:
    name=ID;

Cls:
    'class' name=ID '{' members+=Fn* '}';

Stmt:
    Call | Ret;

Call:
    'call' callee=[Fn:ID] ';';

Ret:
    'return' value=ID? ';';

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;

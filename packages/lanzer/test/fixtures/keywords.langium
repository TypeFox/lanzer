grammar Keywords

entry Doc:
    things+=Thing*;

// Properties named like Lanzer's keywords, so selectors over them can be tested.
Thing:
    'thing' name=ID ('file' file=ID)? ('output' output=STRING)? (not?='negated')? ('run' run=[Thing:ID])? ';';

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"/;

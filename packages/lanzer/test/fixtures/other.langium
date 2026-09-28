grammar Other

entry Doc:
    items+=Fn*;

Fn:
    'item' label=ID;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;

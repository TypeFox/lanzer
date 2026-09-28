grammar Lanzer

interface AbstractRule {
    name: string
}

entry CampaignFile:
    (imports+=GrammarImport | campaigns+=Campaign)*;

GrammarImport:
    'import' path=STRING;

Campaign:
    'campaign' name=ID '{'
        ('description' description=STRING)?
        'workspace' workspaceRoot=STRING
        files+=FileSpec*
        supportFiles+=SupportFileSpec*
        requirements+=CampaignRequirement*
    '}';

FileSpec:
    'file' name=ID
    'at' path=STRING
    'generates' rootRule=[AbstractRule:ID]
    '{'
        ('description' description=STRING)?
        requirements+=FileRequirement*
    '}';

SupportFileSpec:
    'support' name=ID
    'at' path=STRING
    ('description' description=STRING)?;

CampaignRequirement:
    SymbolRequirement |
    CountRequirement |
    ForbidRequirement;

FileRequirement:
    SymbolRequirement |
    CountRequirement |
    ForbidRequirement;

SymbolRequirement:
    'require' selector=Selector ('in' file=[FileSpec:ID])?;

CountRequirement:
    'min' count=INT selector=Selector ('in' file=[FileSpec:ID])?;

ForbidRequirement:
    'forbid' selector=Selector ('in' file=[FileSpec:ID])?;

Selector:
    (leadingCombinator=Combinator)?
    parts+=SelectorPart
    (combinators+=Combinator parts+=SelectorPart)*;

Combinator returns string:
    '>>' | '>';

SelectorPart:
    rule=[AbstractRule:ID]
    (predicates+=Predicate)*
    (pseudos+=PseudoClass)*;

Predicate:
    '['
        property=ID
        (
            (op=PredicateOp value=STRING) |
            ('->' targetRule=[AbstractRule:ID] (nestedPredicates+=Predicate)*)
        )?
    ']';

PredicateOp returns string:
    '=' | '!=' | '^=' | '$=' | '*=';

PseudoClass:
    ':' kind=PseudoClassKind '(' selector=Selector ')';

PseudoClassKind returns string:
    'has' | 'not';

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

terminal ID: /[_a-zA-Z][\w_]*/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/;

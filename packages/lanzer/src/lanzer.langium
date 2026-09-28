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
        runs+=RunSpec*
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

// Run the program from an entry file and check what it does. Every expectation in the block must
// hold. The entry is a generated file or a support file (a fixed driver calling generated code); the
// host decides what running from it means — an interpreter runs it, a compiled language builds the
// workspace and runs its main.
RunSpec:
    'run' entry=[RunEntry:ID] '{'
        expectations+=Expectation*
    '}';

type RunEntry = FileSpec | SupportFileSpec;

// `expect runs` asks only that the program finish without a runtime error or timeout. An output
// check compares the whole output (no mode), a substring (`contains`) or a regex (`matches`);
// `not` inverts it.
Expectation:
    'expect' (
        runs?='runs' |
        (negated?='not')? 'output' (mode=OutputMatchMode)? value=STRING
    );

OutputMatchMode returns string:
    'contains' | 'matches';

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

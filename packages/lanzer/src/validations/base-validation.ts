import type { ValidationChecks } from 'langium';
import type * as ast from '../generated/ast.js';

export abstract class LanzerBaseValidation {
    abstract getChecks(): ValidationChecks<ast.LanzerAstType>;
}

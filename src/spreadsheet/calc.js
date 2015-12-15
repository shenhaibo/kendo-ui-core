// -*- fill-column: 100 -*-

(function(f, define){
    define([ "./runtime" ], f);
})(function(){
    "use strict";

    if (kendo.support.browser.msie && kendo.support.browser.version < 9) {
        return;
    }

    // WARNING: removing the following jshint declaration and turning
    // == into === to make JSHint happy will break functionality.
    /* jshint eqnull:true, newcap:false, laxbreak:true, shadow:true, -W054 */
    /* jshint latedef: nofunc */

    var spreadsheet = kendo.spreadsheet;
    var RangeRef = spreadsheet.RangeRef;
    var CellRef = spreadsheet.CellRef;
    var NameRef = spreadsheet.NameRef;
    var exports = spreadsheet.calc;
    var runtime = exports.runtime;

    // Excel formula parser and compiler to JS.
    // some code adapted from http://lisperator.net/pltut/

    var OPERATORS = Object.create(null);

    var ParseError = kendo.Class.extend({
        init: function ParseError(message, pos) {
            this.message = message;
            this.pos = pos;
        },
        toString: function() {
            return this.message;
        }
    });

    (function(ops){
        ops.forEach(function(cls, i){
            cls.forEach(function(op){
                OPERATORS[op] = ops.length - i;
            });
        });
    })([
        [ ":" ],
        [ "!" ],
        [ " " ],
        [ "," ],
        [ "%" ],
        [ "^" ],
        [ "*", "/" ],
        [ "+", "-" ],
        [ "&" ],
        [ "=", "<", ">", "<=", ">=", "<>" ]
    ]);

    var TRUE = { type: "bool", value: true };
    var FALSE = { type: "bool", value: false };

    function getcol(str) {
        str = str.toUpperCase();
        for (var col = 0, i = 0; i < str.length; ++i) {
            col = col * 26 + str.charCodeAt(i) - 64;
        }
        return col - 1;
    }

    function getrow(str) {
        return parseInt(str, 10) - 1;
    }

    // XXX: rewrite this with the TokenStream.
    function parseReference(name, noThrow) {
        if (name.toLowerCase() == "#sheet") {
            return spreadsheet.SHEETREF;
        }
        OUT: {
            // this is redundant, but let's keep it fast for the most
            // common case — A1.  If this fails, we'll try to employ the
            // whole tokenizer.
            var m;
            if ((m = /^(\$)?([a-z]+)(\$)?(\d+)$/i.exec(name))) {
                var row = getrow(m[4]), col = getcol(m[2]);
                if (row <= 1048576 && col <= 16383) {
                    return new CellRef(getrow(m[4]), getcol(m[2]));
                }
                // no NameRef-s from this function
                break OUT;      // jshint ignore:line
            }
            var stream = TokenStreamWithReferences(InputStream(name));
            var a = [];
            while (true) {
                var ref = stream.next();
                if (ref instanceof CellRef) {
                    // this function always makes absolute references
                    ref.rel = 0;
                } else if (ref instanceof RangeRef) {
                    ref.topLeft.rel = 0;
                    ref.bottomRight.rel = 0;
                } else {
                    break OUT;  // jshint ignore:line
                }
                a.push(ref);
                if (stream.eof()) {
                    break;
                }
                if (!stream.is("op", ",")) {
                    break OUT;  // jshint ignore:line
                }
                stream.next();
            }
            if (!a.length) {
                break OUT;      // jshint ignore:line, you retard
            }
            return a.length == 1 ? a[0] : new spreadsheet.UnionRef(a);
        }
        if (!noThrow) {
            throw new Error("Cannot parse reference: " + name);
        }
    }

    function parseFormula(sheet, row, col, input) {
        var refs = [];
        input = TokenStreamWithReferences(InputStream(input));
        var is = input.is;

        return {
            type: "exp",
            ast: parseExpression(true),
            refs: refs,
            sheet: sheet,
            row: row,
            col: col
        };

        function addReference(ref) {
            ref.index = refs.length;
            refs.push(ref);
            return ref;
        }

        function skip(type, value) {
            if (is(type, value)) {
                return input.next();
            } else {
                var tok = input.peek();
                if (tok) {
                    input.croak("Expected " + type + " «" + value + "» but found " + tok.type + " «" + tok.value + "»");
                } else {
                    input.croak("Expected " + type + " «" + value + "»");
                }
            }
        }

        function parseExpression(commas) {
            return maybeBinary(maybeIntersect(parseAtom(commas)), 0, commas);
        }

        function parseSymbol(tok) {
            if (tok.upper == "TRUE" || tok.upper == "FALSE") {
                return tok.upper == "TRUE" ? TRUE : FALSE;
            }
            return addReference(new NameRef(tok.value));
        }

        function parseFuncall() {
            var fname = input.next();
            fname = fname.value;
            skip("punc", "(");
            var args = [];
            if (!is("punc", ")")) {
                while (1) {
                    if (is("op", ",")) {
                        args.push({ type: "null" });
                        input.next();
                        continue;
                    }
                    args.push(parseExpression(false));
                    if (input.eof() || is("punc", ")")) {
                        break;
                    }
                    skip("op", ",");
                }
            }
            skip("punc", ")");
            return {
                type: "func",
                func: fname,
                args: args
            };
        }

        function fixReference(ref) {
            if (!ref.hasSheet()) {
                ref.setSheet(sheet);
            }
            if (ref instanceof RangeRef) {
                fixReference(ref.topLeft);
                fixReference(ref.bottomRight);
            } else if (ref instanceof CellRef) {
                if (ref.rel & 1) {
                    ref.col -= col;
                }
                if (ref.rel & 2) {
                    ref.row -= row;
                }
            }
            return addReference(ref);
        }

        function parseAtom(commas) {
            var exp;
            if (is("ref")) {
                exp = fixReference(input.next());
            }
            else if (is("func")) {
                exp = parseFuncall();
            }
            else if (is("punc", "(")) {
                input.next();
                exp = parseExpression(true);
                skip("punc", ")");
            }
            else if (is("num") || is("str") || is("sheet")) {
                exp = input.next();
            }
            else if (is("sym")) {
                exp = parseSymbol(input.next());
            }
            else if (is("op", "+") || is("op", "-")) {
                exp = {
                    type: "prefix",
                    op: input.next().value,
                    exp: parseExpression(commas)
                };
            }
            else if (is("punc", "{")) {
                input.next();
                exp = parseArray();
            }
            else if (!input.peek()) {
                input.croak("Incomplete expression");
            }
            else {
                input.croak("Parse error");
            }
            return maybePercent(exp);
        }

        function parseArray() {
            var row = [], value = [ row ], first = true;
            while (!input.eof() && !is("punc", "}")) {
                if (first) {
                    first = false;
                } else if (is("punc", ";")) {
                    value.push(row = []);
                    input.next();
                } else {
                    skip("op", ",");
                }
                row.push(parseExpression(false));
            }
            skip("punc", "}");
            return {
                type: "matrix",
                value: value
            };
        }

        function maybeIntersect(exp) {
            if (is("punc", "(") || is("ref") || is("num") || is("func")) {
                return {
                    type: "binary",
                    op: " ",
                    left: exp,
                    right: parseExpression(false)
                };
            } else {
                return exp;
            }
        }

        function maybePercent(exp) {
            if (is("op", "%")) {
                input.next();
                return maybePercent({
                    type: "postfix",
                    op: "%",
                    exp: exp
                });
            } else {
                return exp;
            }
        }

        function maybeBinary(left, my_prec, commas) {
            var tok = is("op");
            if (tok && (commas || tok.value != ",")) {
                var his_prec = OPERATORS[tok.value];
                if (his_prec > my_prec) {
                    input.next();
                    var right = maybeBinary(parseAtom(commas), his_prec, commas);
                    return maybeBinary({
                        type: "binary",
                        op: tok.value,
                        left: left,
                        right: right
                    }, my_prec, commas);
                }
            }
            return left;
        }
    }

    function makePrinter(exp) {
        return makeClosure("function(row, col){return(" + print(exp.ast, 0) + ")}");
        function print(node, prec) { // jshint ignore:line, because you are stupid.
            switch (node.type) {
              case "num":
              case "bool":
                return JSON.stringify(node.value);
              case "str":
                return JSON.stringify(JSON.stringify(node.value));
              case "ref":
                return "this.refs[" + node.index + "].print(row, col)";
              case "prefix":
                return withParens(node.op, prec, function(){
                    return JSON.stringify(node.op) + " + " + print(node.exp, OPERATORS[node.op]);
                });
              case "postfix":
                return withParens(node.op, prec, function(){
                    return print(node.exp, OPERATORS[node.op]) + " + " + JSON.stringify(node.op);
                });
              case "binary":
                return withParens(node.op, prec, function(){
                    var left = parenthesize(
                        print(node.left, OPERATORS[node.op]),
                        node.left instanceof NameRef && node.op == ":"
                    );
                    var right = parenthesize(
                        print(node.right, OPERATORS[node.op]),
                        node.right instanceof NameRef && node.op == ":"
                    );
                    return left + " + " + JSON.stringify(node.op) + " + " + right;
                });
              case "func":
                return JSON.stringify(node.func + "(") + " + "
                    + (node.args.length > 0
                       ? node.args.map(function(arg){
                           return print(arg, 0);
                       }).join(" + ', ' + ")
                       : "''")
                    + " + ')'";
              case "matrix":
                return "'{ ' + " + node.value.map(function(el){
                    return el.map(function(el){
                        return print(el, 0);
                    }).join(" + ', ' + ");
                }).join(" + '; ' + ") + "+ ' }'";
              case "null":
                return "''";
            }
            throw new Error("Cannot make printer for node " + node.type);
        }
        function parenthesize(code, cond) {
            return cond ? "'(' + " + code + " + ')'" : code;
        }
        function withParens(op, prec, f) {
            var needParens = (OPERATORS[op] < prec || (!prec && op == ","));
            return parenthesize(f(), needParens);
        }
    }

    function toCPS(ast, k) {
        var GENSYM = 0;
        return cps(ast, k);

        function cps(node, k){
            switch (node.type) {
              case "ref"     :
              case "num"     :
              case "str"     :
              case "null"    :
              case "bool"    : return cpsAtom(node, k);
              case "prefix"  :
              case "postfix" : return cpsUnary(node, k);
              case "binary"  : return cpsBinary(node, k);
              case "func"    : return cpsFunc(node, k);
              case "lambda"  : return cpsLambda(node, k);
              case "matrix"  : return cpsMatrix(node.value, k, true);
            }
            throw new Error("Cannot CPS " + node.type);
        }

        function cpsAtom(node, k) {
            return k(node);
        }

        function cpsUnary(node, k) {
            return cps({
                type: "func",
                func: "unary" + node.op,
                args: [ node.exp ]
            }, k);
        }

        function cpsBinary(node, k) {
            return cps({
                type: "func",
                func: "binary" + node.op,
                args: [ node.left, node.right ]
            }, k);
        }

        function cpsIf(co, th, el, k) {
            return cps(co, function(co){
                // compile THEN and ELSE into a lambda which takes a callback to invoke with the
                // result of the branches, and the IF itself will become a call the internal "if"
                // function.
                var rest = makeContinuation(k);
                var thenK = gensym("T");
                var elseK = gensym("E");
                return {
                    type: "func",
                    func: "if",
                    args: [
                        rest,
                        co, // condition
                        { // then
                            type: "lambda",
                            vars: [ thenK ],
                            body: cps(th || TRUE, function(th){
                                return {
                                    type: "call",
                                    func: { type: "var", name: thenK },
                                    args: [ th ]
                                };
                            })
                        },
                        { // else
                            type: "lambda",
                            vars: [ elseK ],
                            body: cps(el || FALSE, function(el){
                                return {
                                    type: "call",
                                    func: { type: "var", name: elseK },
                                    args: [ el ]
                                };
                            })
                        }
                    ]
                };
            });
        }

        function cpsAnd(args, k) {
            if (args.length === 0) {
                return cpsAtom(TRUE, k);
            }
            return cps({
                type: "func",
                func: "IF",
                args: [
                    // first item
                    args[0],
                    // if true, apply AND for the rest
                    {
                        type: "func",
                        func: "AND",
                        args: args.slice(1)
                    },
                    // otherwise return false
                    FALSE
                ]
            }, k);
        }

        function cpsOr(args, k) {
            if (args.length === 0) {
                return cpsAtom(FALSE, k);
            }
            return cps({
                type: "func",
                func: "IF",
                args: [
                    // first item
                    args[0],
                    // if true, return true
                    TRUE,
                    // otherwise apply OR for the rest
                    {
                        type: "func",
                        func: "OR",
                        args: args.slice(1)
                    }
                ]
            }, k);
        }

        function cpsFunc(node, k) {
            switch (node.func.toLowerCase()) {
              case "if":
                return cpsIf(node.args[0], node.args[1], node.args[2], k);
              case "and":
                return cpsAnd(node.args, k);
              case "or":
                return cpsOr(node.args, k);
              case "true":
                return k(TRUE);
              case "false":
                return k(FALSE);
            }
            // actual function
            return (function loop(args, i){
                if (i == node.args.length) {
                    return {
                        type : "func",
                        func : node.func,
                        args : args
                    };
                }
                else {
                    return cps(node.args[i], function(value){
                        return loop(args.concat([ value ]), i + 1);
                    });
                }
            })([ makeContinuation(k) ], 0);
        }

        function cpsLambda(node, k) {
            var cont = gensym("K");
            var body = cps(node.body, function(body){
                return { type: "call",
                         func: { type: "var", value: cont },
                         args: [ body ] };
            });
            return k({ type: "lambda",
                       vars: [ cont ].concat(node.vars),
                       body: body });
        }

        function cpsMatrix(elements, k, isMatrix) {
            var a = [];
            return (function loop(i){
                if (i == elements.length) {
                    return k({
                        type: "matrix",
                        value: a
                    });
                } else {
                    return (isMatrix ? cpsMatrix : cps)(elements[i], function(val){
                        a[i] = val;
                        return loop(i + 1);
                    });
                }
            })(0);
        }

        function makeContinuation(k) {
            var cont = gensym("R");
            return {
                type : "lambda",
                vars : [ cont ],
                body : k({ type: "var", name: cont })
            };
        }

        function gensym(name) {
            if (!name) {
                name = "";
            }
            name = "_" + name;
            return name + (++GENSYM);
        }
    }

    var makeClosure = (function(cache){
        return function(code) {
            var f = cache[code];
            if (!f) {
                f = cache[code] = new Function("'use strict';return(" + code + ")")();
            }
            return f;
        };
    })(Object.create(null));

    var FORMULA_CACHE = Object.create(null);

    function makeFormula(exp) {
        var printer = makePrinter(exp);
        var hash = printer.call(exp); // needs .refs
        var formula = FORMULA_CACHE[hash];
        if (formula) {
            // we need to clone because formulas cache the result; even if the formula is the same,
            // its value will depend on its location, hence we need different objects.  Still, using
            // this cache is a good idea because we'll reuse the same refs array, handler and
            // printer instead of allocating new ones (and we skip compiling it).
            return formula.clone(exp.sheet, exp.row, exp.col);
        }
        var code = js(toCPS(exp.ast, function(ret){
            return {
                type: "return",
                value: ret
            };
        }));

        code = [
            "function(){",
            "var context = this, refs = context.formula.absrefs",
            code,
            "}"
        ].join(";\n");

        formula = new runtime.Formula(exp.refs, makeClosure(code), printer, exp.sheet, exp.row, exp.col);
        FORMULA_CACHE[hash] = formula;
        return formula;

        function js(node){
            var type = node.type;
            if (type == "num") {
                return node.value + "";
            }
            else if (type == "str") {
                return JSON.stringify(node.value);
            }
            else if (type == "return") {
                return "context.resolve(" + js(node.value) + ")";
            }
            else if (type == "func") {
                return "context.func(" + JSON.stringify(node.func) + ", "
                    + js(node.args[0]) + ", " // the callback
                    + jsArray(node.args.slice(1)) // the arguments
                    + ")";
            }
            else if (type == "call") {
                return js(node.func) + "(" + node.args.map(js).join(", ") + ")";
            }
            else if (type == "ref") {
                return "refs[" + node.index + "]";
            }
            else if (type == "bool") {
                return "" + node.value;
            }
            else if (type == "if") {
                return "(context.bool(" + js(node.co) + ") ? " + js(node.th) + " : " + js(node.el) + ")";
            }
            else if (type == "lambda") {
                return "(function("
                    + node.vars.join(", ")
                    + "){ return(" + js(node.body) + ") })";
            }
            else if (type == "var") {
                return node.name;
            }
            else if (type == "matrix") {
                return jsArray(node.value);
            }
            else if (type == "null") {
                return "null";
            }
            else {
                throw new Error("Cannot compile expression " + type);
            }
        }

        function jsArray(a) {
            return "[ " + a.map(js).join(", ") + " ]";
        }
    }

    function TokenStreamWithReferences(input, forEditor) {
        input = TokenStream(input, forEditor);
        var ahead = input.ahead;
        var skip = input.skip;
        var token = null;

        return {
            peek  : peek,
            next  : next,
            croak : input.croak,
            eof   : input.eof,
            is    : is
        };

        function is(type, value) {
            var tok = peek();
            return tok != null
                && (type == null || tok.type === type)
                && (value == null || tok.value === value)
                ? tok : null;
        }

        function peek() {
            if (token == null) {
                token = readNext();
            }
            return token;
        }

        function next() {
            if (token != null) {
                var tmp = token;
                token = null;
                return tmp;
            }
            return readNext();
        }

        function readNext() {
            return ahead(8, refRange3D)
                || ahead(6, refCell3D)
                || ahead(6, refSheetRange)
                || ahead(4, refSheetCell)
                || ahead(4, refRange)
                || ahead(2, refCell)
                || ahead(2, funcall)
                || input.next();
        }

        function toCell(tok, isFirst) {
            if (tok.type == "num" && tok.value <= 1048577) {
                // whole row
                return new CellRef(
                    getrow(tok.value),
                    isFirst ? -Infinity : +Infinity,
                    2
                );
            }
            // otherwise it's "sym".  The OOXML spec (SpreadsheetML
            // 18.2.5) defines the maximum value to be interpreted as
            // a cell reference to be XFD1048576.
            var name = tok.value;
            var m = /^(\$)?([a-z]+)(\$)?(\d+)$/i.exec(name);
            if (m) {
                var row = getrow(m[4]), col = getcol(m[2]);
                if (row <= 1048576 && col <= 16383) {
                    return new CellRef(
                        getrow(m[4]),
                        getcol(m[2]),
                        (m[1] ? 0 : 1) | (m[3] ? 0 : 2)
                    );
                } else {
                    return null;
                }
            }
            var abs = name.charAt(0) == "$";
            if (abs) {
                name = name.substr(1);
            }
            if (/^\d+$/.test(name)) {
                var row = getrow(name);
                if (row <= 1048576) {
                    return new CellRef(
                        getrow(name),
                        isFirst ? -Infinity : +Infinity,
                        (abs ? 0 : 2)
                    );
                }
            } else {
                var col = getcol(name);
                if (col <= 16383) {
                    return new CellRef(
                        isFirst ? -Infinity : +Infinity,
                        getcol(name),
                        (abs ? 0 : 1)
                    );
                }
            }
        }

        // Sheet1(a) :(b) Sheet2(c) !(d) A1(e) :(f) C3(g) not followed by paren (h)
        function refRange3D(a, b, c, d, e, f, g, h) {
            if (a.type == "sym" &&
                b.type == "op" && b.value == ":" &&
                c.type == "sym" &&
                d.type == "op" && d.value == "!" &&
                (e.type == "sym" || (e.type == "num" && e.value == e.value|0)) &&
                f.type == "op" && f.value == ":" &&
                (g.type == "sym" || (g.type == "num" && g.value == g.value|0)) &&
                g.type == e.type &&
                !(h.type == "punc" && h.value == "(" && !g.space))
            {
                var tl = toCell(e, true), br = toCell(g, false);
                if (tl && br) {
                    // skip them except the last one, we only wanted to
                    // ensure it's not paren.
                    skip(7);
                    return new RangeRef(
                        tl.setSheet(a.value, true),
                        br.setSheet(c.value, true)
                    ).setSheet(a.value, true);
                }
            }
        }

        // Sheet1(a) :(b) Sheet2(c) !(d) A1(e) not followed by paren (f)
        function refCell3D(a, b, c, d, e, f) {
            if (a.type == "sym" &&
                b.type == "op" && b.value == ":" &&
                c.type == "sym" &&
                d.type == "op" && d.value == "!" &&
                (e.type == "sym" || (e.type == "num" && e.value == e.value|0)) &&
                !(f.type == "punc" && f.value == "(" && !e.space))
            {
                var tl = toCell(e);
                if (tl) {
                    skip(5);
                    var br = tl.clone();
                    return new RangeRef(
                        tl.setSheet(a.value, true),
                        br.setSheet(c.value, true)
                    ).setSheet(a.value, true);
                }
            }
        }

        // Sheet1(a) !(b) A1(c) :(d) C3(e) not followed by paren (f)
        function refSheetRange(a, b, c, d, e, f) {
            if (a.type == "sym" &&
                b.type == "op" && b.value == "!" &&
                (c.type == "sym" || (c.type == "num" && c.value == c.value|0)) &&
                d.type == "op" && d.value == ":" &&
                (e.type == "sym" || (e.type == "num" && e.value == e.value|0)) &&
                !(f.type == "punc" && f.value == "(" && !e.space))
            {
                var tl = toCell(c, true), br = toCell(e, false);
                if (tl && br) {
                    skip(5);
                    return new RangeRef(tl, br).setSheet(a.value, true);
                }
            }
        }

        // Sheet1(a) !(b) A1(c) not followed by paren (d)
        function refSheetCell(a, b, c, d) {
            if (a.type == "sym" &&
                b.type == "op" && b.value == "!" &&
                (c.type == "sym" || (c.type == "num" && c.value == c.value|0)) &&
                !(d.type == "punc" && d.value == "(" && !c.space))
            {
                skip(3);
                var x = toCell(c);
                if (x) {
                    return x.setSheet(a.value, true);
                }
                return new NameRef(c.value).setSheet(a.value, true);
            }
        }

        // A1(a) :(b) C3(c) not followed by paren (d)
        function refRange(a, b, c, d) {
            if ((a.type == "sym" || (a.type == "num" && a.value == a.value|0)) &&
                (b.type == "op" && b.value == ":") &&
                (c.type == "sym" || (c.type == "num" && c.value == c.value|0)) &&
                !(d.type == "punc" && d.value == "(" && !c.space))
            {
                var tl = toCell(a, true), br = toCell(c, false);
                if (tl && br) {
                    skip(3);
                    return new RangeRef(tl, br);
                }
            }
        }

        // A1(a) not followed by paren (b)
        function refCell(a, b) {
            if (a.type == "sym" && !(b.type == "punc" && b.value == "(" && !a.space)) {
                var x = toCell(a);
                if (x && isFinite(x.row) && isFinite(x.col)) {
                    skip(1);
                    return x;
                }
            }
        }

        function funcall(a, b) {
            if (a.type == "sym" && b.type == "punc" && b.value == "(" && !a.space) {
                a.type = "func";
                skip(1);
                return a;
            }
        }
    }

    function TokenStream(input, forEditor) {
        var tokens = [], index = 0;
        var readWhile = input.readWhile;

        return {
            next  : next,
            peek  : peek,
            eof   : eof,
            croak : input.croak,
            ahead : ahead,
            skip  : skip
        };

        function isDigit(ch) {
            return (/[0-9]/i.test(ch));
        }

        function isIdStart(ch) {
            return (/[a-z$_]/i.test(ch) || ch.toLowerCase() != ch.toUpperCase());
        }

        function isId(ch) {
            return isIdStart(ch) || isDigit(ch) || ch == ".";
        }

        function isOpChar(ch) {
            return ch in OPERATORS;
        }

        function isPunc(ch) {
            return ";(){}[]".indexOf(ch) >= 0;
        }

        function isWhitespace(ch) {
            return " \t\n\xa0".indexOf(ch) >= 0;
        }

        function readNumber() {
            // XXX: TODO: exponential notation
            var has_dot = false;
            var number = readWhile(function(ch){
                if (ch == ".") {
                    if (has_dot) {
                        return false;
                    }
                    has_dot = true;
                    return true;
                }
                return isDigit(ch);
            });
            return { type: "num", value: parseFloat(number) };
        }

        function symbol(id, quote) {
            return {
                type  : "sym",
                value : id,
                upper : id.toUpperCase(),
                space : isWhitespace(input.peek()),
                quote : quote
            };
        }

        function readSymbol() {
            return symbol(readWhile(isId));
        }

        function readString() {
            input.next();
            return { type: "str", value: input.readEscaped('"') };
        }

        function readSheetName() {
            input.next();
            return symbol(input.readEscaped("'"), true);
        }

        function readOperator() {
            return {
                type  : "op",
                value : readWhile(function(ch, op){
                    return (op + ch) in OPERATORS;
                })
            };
        }

        function readPunc() {
            return {
                type  : "punc",
                value : input.next()
            };
        }

        function unknown() {
            return { type: "error", value: input.next() };
        }

        function readNext() {
            if (input.eof()) {
                return null;
            }
            var ch = input.peek(), m;
            if (ch == '"') {
                return readString();
            }
            if (ch == "'") {
                return readSheetName();
            }
            if (isDigit(ch)) {
                return readNumber();
            }
            if (isIdStart(ch)) {
                return readSymbol();
            }
            if (isOpChar(ch)) {
                return readOperator();
            }
            if (isPunc(ch)) {
                return readPunc();
            }
            if ((m = input.lookingAt(/^#([a-z\/]+)[?!]/i))) {
                input.skip(m);
                return { type: "error", value: m[1] };
            }
            if (!forEditor) {
                input.croak("Can't handle character: " + ch);
            }
            return unknown();
        }

        function peek() {
            while (tokens.length <= index) {
                readWhile(isWhitespace);
                var begin = input.pos();
                var tok = readNext();
                if (forEditor && tok) {
                    tok.begin = begin;
                    tok.end = input.pos();
                }
                tokens.push(tok);
            }
            return tokens[index];
        }

        function next() {
            var tok = peek();
            if (tok) {
                index++;
            }
            return tok;
        }

        function ahead(n, f) {
            var pos = index, a = [], eof = { type: "eof" };
            while (n-- > 0) {
                a.push(next() || eof);
            }
            index = pos;
            return f.apply(a, a);
        }

        function skip(n) {
            index += n;
        }

        function eof() {
            return peek() == null;
        }
    }

    function InputStream(input) {
        var pos = 0, line = 1, col = 0;
        return {
            next        : next,
            peek        : peek,
            eof         : eof,
            croak       : croak,
            readWhile   : readWhile,
            readEscaped : readEscaped,
            lookingAt   : lookingAt,
            skip        : skip,
            forward     : forward,
            pos         : location
        };
        function location() { // jshint ignore:line, :-(
            return pos;
        }
        function next() {
            var ch = input.charAt(pos++);
            if (ch == "\n") {
                line++;
                col = 0;
            } else {
                col++;
            }
            return ch;
        }
        function peek() {
            return input.charAt(pos);
        }
        function eof() {
            return peek() === "";
        }
        function croak(msg) {
            throw new ParseError(msg, pos);
        }
        function skip(ch) {
            if (typeof ch == "string") {
                if (input.substr(pos, ch.length) != ch) {
                    croak("Expected " + ch);
                }
                forward(ch.length);
            } else if (ch instanceof RegExp) {
                var m = ch.exec(input.substr(pos));
                if (m) {
                    forward(m[0].length);
                    return m;
                }
            } else {
                // assuming RegExp match data
                forward(ch[0].length);
            }
        }
        function forward(n) {
            while (n-- > 0) {
                next();
            }
        }
        function readEscaped(end) {
            var escaped = false, str = "";
            while (!eof()) {
                var ch = next();
                if (escaped) {
                    str += ch;
                    escaped = false;
                } else if (ch == "\\") {
                    escaped = true;
                } else if (ch == end) {
                    break;
                } else {
                    str += ch;
                }
            }
            return str;
        }
        function readWhile(predicate) {
            var str = "";
            while (!eof() && predicate(peek(), str)) {
                str += next();
            }
            return str;
        }
        function lookingAt(rx) {
            return rx.exec(input.substr(pos));
        }
    }

    //// exports

    exports.parse = function(sheet, row, col, input) {
        if (input instanceof Date) {
            return { type: "date", value: runtime.dateToSerial(input) };
        }
        if (typeof input == "number") {
            return { type: "number", value: input };
        }
        if (typeof input == "boolean") {
            return { type: "boolean", value: input };
        }
        input += "";
        if (/^'/.test(input)) {
            return {
                type: "string",
                value: input.substr(1)
            };
        }
        if (/^[0-9.]+%$/.test(input)) {
            var str = input.substr(0, input.length - 1);
            var num = parseFloat(str);
            if (!isNaN(num) && num == str) {
                return {
                    type: "percent",
                    value: num / 100
                };
            }
        }
        if (/^=/.test(input)) {
            input = input.substr(1);
            if (/\S/.test(input)) {
                return parseFormula(sheet, row, col, input);
            } else {
                return {
                    type: "string",
                    value: "=" + input
                };
            }
        }
        if (input.toLowerCase() == "true") {
            return { type: "boolean", value: true };
        }
        if (input.toLowerCase() == "false") {
            return { type: "boolean", value: false };
        }
        var date = runtime.parseDate(input);
        if (date) {
            return { type: "date", value: runtime.dateToSerial(date) };
        }
        var num = parseFloat(input);
        if (!isNaN(num) && input.length > 0 && num == input) {
            return {
                type: "number",
                value: num
            };
        }
        return {
            type: "string",
            value: input
        };
    };

    function looksLikeRange(a, b, c, d) {
        // We need c.space here to resolve an ambiguity:
        //
        //   - A1:C3 (A2, A3) -- parse as intersection between range and union
        //
        //   - A1:CHOOSE(2, A1, A2, A3) -- parse as range operator where the
        //     bottom-right side is returned by the CHOOSE function
        //
        // note no space between CHOOSE and the paren in the second example.
        // I believe this is the Right Way™.
        return ((a.type == "sym" || (a.type == "num" && a.value == a.value|0)) &&
                (b.type == "op" && b.value == ":") &&
                (c.type == "sym" || (c.type == "num" && c.value == c.value|0)) &&
                !(d.type == "punc" && d.value == "(" && !c.space));
    }

    function tokenize(input) {
        var tokens = [];
        input = TokenStream(InputStream(input), true);
        while (!input.eof()) {
            tokens.push(input.ahead(4, maybeRange) ||
                        input.ahead(2, maybeCall) ||
                        next());
        }
        var tok = tokens[0];
        if (tok.type == "op" && tok.value == "=") {
            tok.type = "startexp";
        }
        return tokens;

        function maybeRange(a, b, c, d) {
            if (looksLikeRange(a, b, c, d)) {
                var ref = parseReference(a.value + ":" + c.value, true);
                if (ref) {
                    input.skip(3);
                    return {
                        type: "ref",
                        ref: ref,
                        begin: a.begin,
                        end: c.end
                    };
                }
            }
        }
        function next() {
            var tok = input.next();
            if (tok.type == "sym") {
                var ref = parseReference(tok.value, true);
                if (ref) {
                    tok.type = "ref";
                    tok.ref = ref;
                } else if (tok.upper == "TRUE") {
                    tok.type = "bool";
                    tok.value = true;
                } else if (tok.upper == "FALSE") {
                    tok.type = "bool";
                    tok.value = false;
                }
            }
            return tok;
        }
        function maybeCall(fname, b) {
            if (fname.type == "sym" && b.type == "punc" && b.value == "(") {
                input.skip(1);
                fname.type = "func";
                return fname;
            }
        }
    }

    exports.parseFormula = parseFormula;
    exports.parseReference = parseReference;
    exports.compile = makeFormula;

    exports.InputStream = InputStream;
    exports.ParseError = ParseError;
    exports.tokenize = tokenize;

}, typeof define == 'function' && define.amd ? define : function(a1, a2, a3){ (a3 || a2)(); });

# Concept-JOIN gate — failure analysis (nmemo-uhp.24, doc-20 §13)

Resolution: 5 merged / 5 judged-same / 37 pairs considered.

## Resolution merges (what the Haiku judge collapsed)
- Concept resolution: "unsafe-cast" == "unsafe-casting" (trigram 0.69, judge confirmed)
- Concept resolution: "nested-namespace" == "namespace-nesting" (trigram 0.65, judge confirmed)
- Concept resolution: "const-reference-parameter" == "pass-by-const-reference" (trigram 0.56, judge confirmed)
- Concept resolution: "const-member-variable" == "const-data-member" (trigram 0.48, judge confirmed)
- Concept resolution: "constexpr-constant" == "constexpr-variable" (trigram 0.43, judge confirmed)

## Convergence: 8/29 true pairs share ≥1 concept node

Per-guideline (JOIN can only recall a pair if code & rule share a concept node):

| guideline | n | connected | JOIN@5 | cosine@5 |
|-----------|---|-----------|--------|----------|
| C.12 | 1 | 1/1 | 1.00 | 1.00 |
| C.48 | 1 | 0/1 | 0.00 | 0.00 |
| ES.20 | 1 | 0/1 | 0.00 | 0.00 |
| ES.30 | 6 | 3/6 | 0.50 | 0.50 |
| ES.42 | 5 | 4/5 | 0.80 | 0.20 |
| ES.45 | 6 | 0/6 | 0.00 | 0.83 |
| ES.75 | 1 | 0/1 | 0.00 | 0.00 |
| F.16 | 2 | 0/2 | 0.00 | 1.00 |
| Type.1 | 6 | 0/6 | 0.00 | 0.67 |

## The vocabulary gap — every true pair (★ = shared node exists)

### C.12 — "Do not make data members const or references in a copyable/movable type."
★ E016  JOIN-rank 1 / cos-rank 1
    code: const-member-variable, shared-pointer
    rule: const-member-variable, copy-assignment, move-assignment, reference-data-member
    shared: const-member-variable

### C.48 — "Initialize all data members."
· E017  JOIN-rank 27 / cos-rank 25
    code: const-qualification, pointer-null-check, stack-allocation, unsigned-integer-arithmetic
    rule: member-initialization, uninitialized-member

### ES.20 — "Always initialize an object/variable."
· E022 [sub-lexical]  JOIN-rank 27 / cos-rank 16
    code: constexpr-evaluation, type-trait, variant
    rule: uninitialised-variable

### ES.30 — "Do not use macros for constants or functions; prefer constexpr/inline."
★ E024  JOIN-rank 1 / cos-rank 1
    code: constexpr-constant, floating-point-literal, namespace-declaration, preprocessor-macro
    rule: macro-constant, macro-function, preprocessor-macro
    shared: preprocessor-macro
· E025 [sub-lexical]  JOIN-rank 27 / cos-rank 9
    code: header-inclusion, macro-definition, namespace-declaration, using-declaration
    rule: macro-constant, macro-function, preprocessor-macro
★ E026 [sub-lexical]  JOIN-rank 1 / cos-rank 8
    code: nested-namespace, preprocessor-macro, public-inheritance
    rule: macro-constant, macro-function, preprocessor-macro
    shared: preprocessor-macro
★ E027 [sub-lexical]  JOIN-rank 2 / cos-rank 6
    code: const-reference-parameter, preprocessor-macro, template-instantiation
    rule: macro-constant, macro-function, preprocessor-macro
    shared: preprocessor-macro
· E028 [sub-lexical]  JOIN-rank 27 / cos-rank 4
    code: header-inclusion, macro-definition, nested-namespace
    rule: macro-constant, macro-function, preprocessor-macro
· E029  JOIN-rank 27 / cos-rank 1
    code: compile-time-constant, internal-linkage, macro-definition, test-framework-integration
    rule: macro-constant, macro-function, preprocessor-macro

### ES.42 — "Keep pointer use simple; avoid pointer arithmetic."
★ E001  JOIN-rank 1 / cos-rank 2
    code: compile-time-type-assertion, error-code-checking, input-consumption-validation, pointer-arithmetic
    rule: pointer-arithmetic
    shared: pointer-arithmetic
· E003 [sub-lexical]  JOIN-rank 27 / cos-rank 7
    code: heap-allocation, range-constructor, raw-pointer-arithmetic
    rule: pointer-arithmetic
★ E004  JOIN-rank 1 / cos-rank 6
    code: overlapping-memory-move, pointer-arithmetic
    rule: pointer-arithmetic
    shared: pointer-arithmetic
★ E007  JOIN-rank 1 / cos-rank 7
    code: pointer-arithmetic, unchecked-offset
    rule: pointer-arithmetic
    shared: pointer-arithmetic
★ E020 [sub-lexical]  JOIN-rank 1 / cos-rank 9
    code: exception-throwing, method-forwarding, pointer-arithmetic, range-insertion, reinterpret-cast, state-guard
    rule: pointer-arithmetic
    shared: pointer-arithmetic

### ES.45 — "Avoid "magic" constants; use symbolic/named constants."
· E010 [sub-lexical]  JOIN-rank 27 / cos-rank 7
    code: constexpr-constant, explicit-template-specialization, inline-variable
    rule: magic-constant
· E011 [sub-lexical]  JOIN-rank 27 / cos-rank 4
    code: compile-time-constant, explicit-template-specialization, floating-point-literal-scientific-notation, variable-template
    rule: magic-constant
· E012 [sub-lexical]  JOIN-rank 27 / cos-rank 5
    code: constexpr-constant, template-specialization
    rule: magic-constant
· E013 [sub-lexical]  JOIN-rank 27 / cos-rank 5
    code: compile-time-constant, explicit-template-specialization, floating-point-literal, variable-template
    rule: magic-constant
· E014 [sub-lexical]  JOIN-rank 27 / cos-rank 5
    code: constexpr-constant, explicit-template-specialization, floating-point-literal, inline-variable
    rule: magic-constant
· E015 [sub-lexical]  JOIN-rank 27 / cos-rank 5
    code: constexpr-evaluation, explicit-template-specialization, floating-point-literal, static-initialization
    rule: magic-constant

### ES.75 — "Avoid do-while loops."
· E023 [sub-lexical]  JOIN-rank 27 / cos-rank 17
    code: explicit-type-casting, ldlt-decomposition, numeric-limits-sentinel, template-specialization, vector-arithmetic
    rule: guaranteed-iteration, post-condition-loop

### F.16 — "For "in" parameters, pass cheaply-copied types by value and others by reference to const; avoid unnecessary by-value copies."
· E008  JOIN-rank 27 / cos-rank 1
    code: const-qualification, exception-handling, shared-pointer, template-specialization
    rule: const-reference-parameter, pass-by-value, unnecessary-copy
· E009  JOIN-rank 27 / cos-rank 1
    code: const-qualification, delegation, error-code-return, pair-container, shared-pointer, template-function
    rule: const-reference-parameter, pass-by-value, unnecessary-copy

### Type.1 — "Avoid reinterpret_cast; do not use unsafe casts."
· E002  JOIN-rank 27 / cos-rank 6
    code: move-semantics, reinterpret-cast
    rule: type-punning, unsafe-cast
· E005  JOIN-rank 27 / cos-rank 3
    code: integer-conversion, reinterpret-cast
    rule: type-punning, unsafe-cast
· E006  JOIN-rank 27 / cos-rank 4
    code: numeric-cast, reinterpret-cast
    rule: type-punning, unsafe-cast
· E018  JOIN-rank 27 / cos-rank 3
    code: eof-loop, raw-pointer-to-string, reinterpret-cast, size-checking
    rule: type-punning, unsafe-cast
· E019  JOIN-rank 27 / cos-rank 7
    code: integer-narrowing, reinterpret-cast
    rule: type-punning, unsafe-cast
· E021  JOIN-rank 27 / cos-rank 3
    code: pointer-arithmetic, reinterpret-cast
    rule: type-punning, unsafe-cast
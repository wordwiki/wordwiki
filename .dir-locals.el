;;; Directory Local Variables  -*- no-byte-compile: t -*-
;;; This project is formatted with a 4-space indent (overriding a 2-space
;;; default).  A .dir-locals.el at the project root applies recursively, so
;;; this covers wordwiki/, rabid/, liminal/ and everything else below it.
;;; See: M-x info -> Emacs -> Variables -> Directory Variables.

((nil
  ;; spaces, never tabs - and a tab still reads as 4 columns
  (indent-tabs-mode . nil)
  (tab-width . 4))

 ;; TypeScript (the bulk of the project: .ts)
 (typescript-mode
  (typescript-indent-level . 4))
 (typescript-ts-mode               ; tree-sitter variant
  (typescript-ts-mode-indent-offset . 4))
 (tsx-ts-mode
  (typescript-ts-mode-indent-offset . 4))

 ;; Plain JavaScript (resources/*.js) - also the js-ts-mode tree-sitter variant
 (js-mode
  (js-indent-level . 4))
 (js-ts-mode
  (js-indent-level . 4))
 (js2-mode
  (js2-basic-offset . 4))

 ;; CSS (resources/*.css)
 (css-mode
  (css-indent-offset . 4))
 (css-ts-mode
  (css-indent-offset . 4))

 ;; HTML / mixed templates, if edited via web-mode
 (web-mode
  (web-mode-code-indent-offset . 4)
  (web-mode-markup-indent-offset . 4)
  (web-mode-css-indent-offset . 4)))

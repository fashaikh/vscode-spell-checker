import {
    TextDocument,
    TextDocuments,
    CodeActionParams,
} from 'vscode-languageserver';
import {
    CodeAction,
} from 'vscode-languageserver-types';
import * as LangServer from 'vscode-languageserver';
import { Text } from 'cspell-lib';
import * as Validator from './validator';
import { CSpellUserSettings } from './cspellConfig';
import { SpellingDictionary } from 'cspell-lib';
import * as cspell from 'cspell-lib';
import { isUriAllowed, DocumentSettings } from './documentSettings';
import { SuggestionGenerator, GetSettingsResult } from './SuggestionsGenerator';
import { uniqueFilter, log } from './util';

function extractText(textDocument: TextDocument, range: LangServer.Range) {
    const { start, end } = range;
    const offStart = textDocument.offsetAt(start);
    const offEnd = textDocument.offsetAt(end);
    return textDocument.getText().slice(offStart, offEnd);
}


export function onCodeActionHandler(
    documents: TextDocuments,
    fnSettings: (doc: TextDocument) => Promise<CSpellUserSettings>,
    fnSettingsVersion: (doc: TextDocument) => number,
    documentSettings: DocumentSettings,
): (params: CodeActionParams) => Promise<CodeAction[]> {
    type SettingsDictPair = GetSettingsResult;
    interface CacheEntry {
        docVersion: number;
        settingsVersion: number;
        settings: Promise<SettingsDictPair>;
    }

    const sugGen = new SuggestionGenerator(getSettings);
    const settingsCache = new Map<string, CacheEntry>();

    async function getSettings(doc: TextDocument): Promise<GetSettingsResult> {
        const cached = settingsCache.get(doc.uri);
        const settingsVersion = fnSettingsVersion(doc);
        if (!cached || cached.docVersion !== doc.version || cached.settingsVersion !== settingsVersion) {
            const settings = constructSettings(doc);
            settingsCache.set(doc.uri, { docVersion: doc.version, settings, settingsVersion });
        }
        return settingsCache.get(doc.uri)!.settings;
    }

    async function constructSettings(doc: TextDocument): Promise<SettingsDictPair> {
        const settings = cspell.constructSettingsForText(await fnSettings(doc), doc.getText(), doc.languageId);
        const dictionary = await cspell.getDictionary(settings);
        return  { settings, dictionary };
    }

    const handler = async (params: CodeActionParams) => {
        const actions: CodeAction[] = [];
        const { context, textDocument: { uri } } = params;
        const { diagnostics } = context;
        log(`CodeAction Only: ${context.only} Num: ${diagnostics.length}`, uri);
        const optionalTextDocument = documents.get(uri);
        if (!optionalTextDocument || !diagnostics.length) return [];
        const textDocument = optionalTextDocument;
        const { settings: docSetting, dictionary } = await getSettings(textDocument);
        if (!isUriAllowed(uri, docSetting.allowedSchemas)) {
            return [];
        }
        const folders = await documentSettings.folders;
        const showAddToWorkspace = folders && folders.length > 1;
        const showAddToFolder = folders && folders.length > 0;

        function replaceText(range: LangServer.Range, text?: string) {
            return LangServer.TextEdit.replace(range, text || '');
        }

        function getSuggestions(word: string) {
            return sugGen.genWordSuggestions(textDocument, word);
        }

        function createAction(title: string, command: string, diags: LangServer.Diagnostic[] | undefined, ...args: any[]): CodeAction {
            const cmd = LangServer.Command.create(
                title,
                command,
                ...args
            );
            const action = LangServer.CodeAction.create(title, cmd);
            action.diagnostics = diags;
            action.kind = LangServer.CodeActionKind.QuickFix;
            return action;
        }

        async function genCodeActionsForSuggestions(_dictionary: SpellingDictionary) {
            const spellCheckerDiags = diagnostics.filter(diag => diag.source === Validator.diagSource);
            let diagWord: string | undefined;
            for (const diag of spellCheckerDiags) {
                const word = extractText(textDocument, diag.range);
                diagWord = diagWord || word;
                const sugs: string[] = await getSuggestions(word);
                sugs
                    .map(sug => Text.isLowerCase(sug) ? Text.matchCase(word, sug) : sug)
                    .filter(uniqueFilter())
                    .forEach(sugWord => {
                        const action = createAction(
                            sugWord,
                            'cSpell.editText',
                            [diag],
                            uri,
                            textDocument.version,
                            [ replaceText(diag.range, sugWord) ]
                        );
                        /**
                          * Waiting on [Add isPreferred to the CodeAction protocol. Pull Request #489 · Microsoft/vscode-languageserver-node](https://github.com/Microsoft/vscode-languageserver-node/pull/489)
                          * Note we might want this to be a config setting incase someone has `"editor.codeActionsOnSave": { "source.fixAll": true }`
                          * if (!actions.length) {
                          *     action.isPreferred = true;
                          * }
                          */
                        actions.push(action);
                    });
            }
            const word = diagWord || extractText(textDocument, params.range);
            // Only suggest adding if it is our diagnostic and there is a word.
            if (word && spellCheckerDiags.length) {
                actions.push(createAction(
                    'Add: "' + word + '" to user dictionary',
                    'cSpell.addWordToUserDictionarySilent',
                    spellCheckerDiags,
                    word,
                    textDocument.uri
                ));
                if (showAddToFolder) {
                    // Allow the them to add it to the project dictionary.
                    actions.push(createAction(
                        'Add: "' + word + '" to folder dictionary',
                        'cSpell.addWordToDictionarySilent',
                        spellCheckerDiags,
                        word,
                        textDocument.uri
                    ));
                }
                if (showAddToWorkspace) {
                    // Allow the them to add it to the workspace dictionary.
                    actions.push(createAction(
                        'Add: "' + word + '" to workspace dictionary',
                        'cSpell.addWordToWorkspaceDictionarySilent',
                        spellCheckerDiags,
                        word,
                        textDocument.uri
                    ));
                }
            }
            return actions;
        }

        return genCodeActionsForSuggestions(dictionary);
    };

    return handler;
}

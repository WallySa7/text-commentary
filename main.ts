import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	Menu,
} from "obsidian";

interface CommentaryPluginSettings {
	defaultCollapsed: boolean;
	highlightDuration: number;
	footnotePrefix: string;
	enableQuickToolbar: boolean;
	defaultFootnoteType: string;
	enableStatistics: boolean;
	enableBlockTags: boolean;
}

const DEFAULT_SETTINGS: CommentaryPluginSettings = {
	defaultCollapsed: false,
	highlightDuration: 2000,
	footnotePrefix: "note",
	enableQuickToolbar: true,
	defaultFootnoteType: "note",
	enableStatistics: true,
	enableBlockTags: true,
};

// Footnote types with icons and colors
const FOOTNOTE_TYPES = {
	note: { icon: "📝", color: "var(--text-normal)" },
	warning: { icon: "⚠️", color: "var(--text-warning)" },
	info: { icon: "ℹ️", color: "var(--text-accent)" },
	reference: { icon: "📚", color: "var(--text-muted)" },
	idea: { icon: "💡", color: "var(--interactive-accent)" },
	question: { icon: "❓", color: "var(--text-error)" },
};

interface CommentaryBlockBounds {
	startLine: number;
	endLine: number;
	textStart?: number;
	textEnd?: number;
	commentaryStart?: number;
	commentaryEnd?: number;
	footnoteStart?: number;
	footnoteEnd?: number;
	metadataStart?: number;
	metadataEnd?: number;
}

export default class CommentaryPlugin extends Plugin {
	settings: CommentaryPluginSettings;
	blockCounter: number = 0;
	blockRegistry: Map<string, any> = new Map();

	async onload() {
		await this.loadSettings();

		// Register the code block processor for commentary blocks
		this.registerMarkdownCodeBlockProcessor(
			"commentary",
			(source, el, ctx) => {
				this.processCommentaryBlock(source, el, ctx);
			}
		);

		// Add command to insert commentary block
		this.addCommand({
			id: "insert-commentary-block",
			name: "Insert Commentary Block",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.insertCommentaryBlock(editor);
			},
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "c" }],
		});

		// Add command to insert footnote (unified command)
		this.addCommand({
			id: "insert-footnote",
			name: "Insert/Navigate Footnote",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.handleFootnote(editor);
			},
			hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "f" }],
		});

		// Add command to toggle all blocks
		this.addCommand({
			id: "toggle-all-blocks",
			name: "Toggle All Commentary Blocks",
			callback: () => {
				this.toggleAllBlocks();
			},
		});

		// Add settings tab
		this.addSettingTab(new CommentarySettingTab(this.app, this));

		// Add styles
		this.addStyles();
	}

	// NEW: Helper method to find current commentary block boundaries
	getCurrentCommentaryBlockBounds(
		editor: Editor,
		cursorLine: number
	): CommentaryBlockBounds | null {
		const lines = editor.getValue().split("\n");
		let blockStart = -1;
		let blockEnd = -1;

		// Find the start of the current commentary block
		for (let i = cursorLine; i >= 0; i--) {
			if (lines[i].startsWith("```commentary")) {
				blockStart = i;
				break;
			}
			if (lines[i].startsWith("```") && i < cursorLine) {
				// Found a different code block, cursor is not in commentary block
				return null;
			}
		}

		if (blockStart === -1) {
			return null; // Not in a commentary block
		}

		// Find the end of the current commentary block
		for (let i = blockStart + 1; i < lines.length; i++) {
			if (lines[i].startsWith("```")) {
				blockEnd = i;
				break;
			}
		}

		if (blockEnd === -1) {
			blockEnd = lines.length; // Block extends to end of file
		}

		// Find section boundaries within the block
		const bounds: CommentaryBlockBounds = {
			startLine: blockStart,
			endLine: blockEnd,
		};

		let currentSection = "";
		for (let i = blockStart + 1; i < blockEnd; i++) {
			const line = lines[i];

			if (line.startsWith("---metadata---")) {
				if (currentSection === "metadata") bounds.metadataEnd = i;
				bounds.metadataStart = i;
				currentSection = "metadata";
			} else if (line.startsWith("---text---")) {
				if (currentSection === "metadata") bounds.metadataEnd = i;
				if (currentSection === "text") bounds.textEnd = i;
				bounds.textStart = i;
				currentSection = "text";
			} else if (line.startsWith("---commentary---")) {
				if (currentSection === "text") bounds.textEnd = i;
				if (currentSection === "commentary") bounds.commentaryEnd = i;
				bounds.commentaryStart = i;
				currentSection = "commentary";
			} else if (line.startsWith("---footnote---")) {
				if (currentSection === "commentary") bounds.commentaryEnd = i;
				if (currentSection === "footnote") bounds.footnoteEnd = i;
				bounds.footnoteStart = i;
				currentSection = "footnote";
			}
		}

		// Set end boundaries for the last section
		if (
			currentSection === "metadata" &&
			bounds.metadataStart !== undefined
		) {
			bounds.metadataEnd = blockEnd;
		} else if (
			currentSection === "text" &&
			bounds.textStart !== undefined
		) {
			bounds.textEnd = blockEnd;
		} else if (
			currentSection === "commentary" &&
			bounds.commentaryStart !== undefined
		) {
			bounds.commentaryEnd = blockEnd;
		} else if (
			currentSection === "footnote" &&
			bounds.footnoteStart !== undefined
		) {
			bounds.footnoteEnd = blockEnd;
		}

		return bounds;
	}

	processCommentaryBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const blockId = `commentary-block-${this.blockCounter++}`;

		// Parse the source content
		const { originalText, commentary, footnotes, metadata } =
			this.parseBlockContent(source);

		// Store block data for later reference
		this.blockRegistry.set(blockId, {
			originalText,
			commentary,
			footnotes,
			metadata,
		});

		// Create the block container
		const container = el.createDiv({ cls: "commentary-block-container" });
		container.setAttribute("data-block-id", blockId);

		// Add tags if enabled and present
		if (this.settings.enableBlockTags && metadata.tags) {
			const tagsContainer = container.createDiv({
				cls: "commentary-block-tags",
			});
			metadata.tags.forEach((tag: string) => {
				tagsContainer.createEl("span", {
					cls: "commentary-tag",
					text: `#${tag}`,
				});
			});
		}

		// Create header with collapse button and title
		const header = container.createDiv({ cls: "commentary-block-header" });
		const collapseBtn = header.createEl("button", {
			cls: "commentary-collapse-btn",
			text: this.settings.defaultCollapsed ? "▶" : "▼",
		});

		const title = header.createEl("span", {
			cls: "commentary-block-title",
			text: metadata.title || "Commentary Block",
		});

		// Add quick toolbar if enabled
		if (this.settings.enableQuickToolbar) {
			const toolbar = header.createDiv({ cls: "commentary-toolbar" });
			this.createQuickToolbar(toolbar, blockId);
		}

		// Create content container
		const content = container.createDiv({
			cls: "commentary-block-content",
		});

		if (this.settings.defaultCollapsed) {
			content.addClass("collapsed");
		}

		// Add original text section
		if (originalText.trim()) {
			const textSection = content.createDiv({
				cls: "commentary-original-text",
			});
			const textHeader = textSection.createEl("h4", {
				text: "Original Text (متن)",
			});
			const textContent = textSection.createDiv({
				cls: "original-text-content",
			});
			MarkdownRenderer.renderMarkdown(
				originalText,
				textContent,
				"",
				null
			);
		}

		// Process and add commentary with footnotes
		const commentarySection = content.createDiv({
			cls: "commentary-section",
		});
		const commentaryHeader = commentarySection.createEl("h4", {
			text: "Commentary",
		});

		// Add statistics if enabled
		if (this.settings.enableStatistics) {
			const stats = this.calculateStatistics(commentary, footnotes);
			const statsEl = commentaryHeader.createEl("span", {
				cls: "commentary-stats",
				text: ` (${stats.words} words, ${stats.footnotes} footnotes)`,
			});
		}

		const commentaryContent = commentarySection.createDiv({
			cls: "commentary-content",
		});

		// Process footnotes in commentary using the footnotes section
		const { processedText, footnotesList } = this.processFootnotes(
			commentary,
			footnotes,
			blockId
		);

		// Render the processed commentary
		const commentaryBody = commentaryContent.createDiv({
			cls: "commentary-body",
		});
		this.renderCommentaryWithFootnotes(
			processedText,
			commentaryBody,
			blockId
		);

		// Add footnotes section if there are any
		if (footnotesList.length > 0) {
			const footnotesSection = commentaryContent.createDiv({
				cls: "commentary-footnotes",
			});
			const footnotesHeader = footnotesSection.createEl("h5", {
				text: "Footnotes",
			});
			const footnotesList_el = footnotesSection.createEl("ol", {
				cls: "footnotes-list",
			});

			footnotesList.forEach((footnote, index) => {
				const li = footnotesList_el.createEl("li");
				li.setAttribute("id", `${blockId}-footnote-${index + 1}`);
				li.setAttribute("data-footnote-num", String(index + 1));

				// Parse footnote type and content
				const { type, content } = this.parseFootnoteContent(footnote);
				const footnoteType =
					FOOTNOTE_TYPES[type] || FOOTNOTE_TYPES.note;

				// Add type icon
				if (footnoteType.icon) {
					li.createEl("span", {
						cls: "footnote-type-icon",
						text: footnoteType.icon + " ",
					});
				}

				// Add back reference
				const backRef = li.createEl("a", {
					cls: "footnote-backref",
					text: "↩",
					href: `#${blockId}-ref-${index + 1}`,
				});
				backRef.addEventListener("click", (e) => {
					e.preventDefault();
					this.scrollToAndHighlight(`${blockId}-ref-${index + 1}`);
				});

				li.createEl("span", { text: " " });

				// Render footnote content
				const footnoteContent = li.createEl("span", {
					cls: "footnote-text",
				});
				footnoteContent.style.color = footnoteType.color;

				// Handle multi-line footnotes
				const tempDiv = document.createElement("div");
				MarkdownRenderer.renderMarkdown(content, tempDiv, "", null);

				// Process rendered content to maintain proper formatting
				this.processFootnoteContent(tempDiv, footnoteContent);
			});
		}

		// Add collapse functionality
		collapseBtn.addEventListener("click", () => {
			content.classList.toggle("collapsed");
			collapseBtn.textContent = content.classList.contains("collapsed")
				? "▶"
				: "▼";
		});
	}

	parseBlockContent(source: string) {
		const lines = source.split("\n");
		let originalText = "";
		let commentary = "";
		let footnotes = "";
		let metadata: any = {};
		let currentSection = "";

		for (const line of lines) {
			if (line.startsWith("---text---")) {
				currentSection = "text";
				continue;
			}
			if (line.startsWith("---commentary---")) {
				currentSection = "commentary";
				continue;
			}
			if (line.startsWith("---footnote---")) {
				currentSection = "footnote";
				continue;
			}
			if (line.startsWith("---metadata---")) {
				currentSection = "metadata";
				continue;
			}

			switch (currentSection) {
				case "text":
					originalText += line + "\n";
					break;
				case "commentary":
					commentary += line + "\n";
					break;
				case "footnote":
					footnotes += line + "\n";
					break;
				case "metadata":
					// Parse metadata lines (e.g., title: My Title, tags: tag1, tag2)
					const metaMatch = line.match(/^(\w+):\s*(.+)$/);
					if (metaMatch) {
						const [, key, value] = metaMatch;
						if (key === "tags") {
							metadata[key] = value
								.split(",")
								.map((t) => t.trim());
						} else {
							metadata[key] = value.trim();
						}
					}
					break;
			}
		}

		return { originalText, commentary, footnotes, metadata };
	}

	processFootnotes(
		commentaryText: string,
		footnotesText: string,
		blockId: string
	): { processedText: string; footnotesList: string[] } {
		const footnotesList: string[] = [];
		const footnoteDefinitions: Map<number, string> = new Map();

		// First, find all footnote definitions in the footnotes section: $[1]: content here
		const definitionPattern =
			/\$\[(\d+)\]:\s*(.+(?:\n(?!\$\[\d+\]:|\n\s*$).*)*)/gm;

		// Extract footnote definitions from the footnotes section
		let defMatch;
		definitionPattern.lastIndex = 0;
		while ((defMatch = definitionPattern.exec(footnotesText)) !== null) {
			const num = parseInt(defMatch[1]);
			const content = defMatch[2].trim();
			footnoteDefinitions.set(num, content);
		}

		// Find all footnote references in the commentary: $[1], $[2], etc.
		const referencePattern = /\$\[(\d+)\]/g;
		const references: Array<{ match: string; num: number; index: number }> =
			[];
		let refMatch;

		referencePattern.lastIndex = 0;
		while ((refMatch = referencePattern.exec(commentaryText)) !== null) {
			const num = parseInt(refMatch[1]);
			references.push({
				match: refMatch[0],
				num: num,
				index: refMatch.index,
			});
		}

		// Sort references by their position in the text
		references.sort((a, b) => a.index - b.index);

		// Create footnotes array in order of appearance and replace references
		let processedText = commentaryText;
		let offset = 0;
		const usedFootnotes: Set<number> = new Set();

		references.forEach((ref) => {
			if (!usedFootnotes.has(ref.num)) {
				// Add to footnotes array if we haven't seen this number before
				const content =
					footnoteDefinitions.get(ref.num) ||
					`Missing footnote definition for ${ref.num}`;
				footnotesList.push(content);
				usedFootnotes.add(ref.num);
			}

			// Get the position of this footnote in the final footnotes array
			const footnoteIndex =
				Array.from(usedFootnotes)
					.sort((a, b) => {
						// Find first occurrence of each footnote number
						const aIndex =
							references.find((r) => r.num === a)?.index ?? 0;
						const bIndex =
							references.find((r) => r.num === b)?.index ?? 0;
						return aIndex - bIndex;
					})
					.indexOf(ref.num) + 1;

			// Calculate the actual position accounting for previous replacements
			const actualIndex = ref.index + offset;
			const replacement = `{{fnref:${footnoteIndex}}}`;

			// Replace the reference with the internal marker
			processedText =
				processedText.substring(0, actualIndex) +
				replacement +
				processedText.substring(actualIndex + ref.match.length);

			// Update offset
			offset += replacement.length - ref.match.length;
		});

		return { processedText, footnotesList };
	}

	parseFootnoteContent(footnote: string): { type: string; content: string } {
		const typeMatch = footnote.match(/^(\w+):(.*)$/s);
		if (typeMatch && FOOTNOTE_TYPES[typeMatch[1]]) {
			return { type: typeMatch[1], content: typeMatch[2].trim() };
		}
		return { type: "note", content: footnote };
	}

	processFootnoteContent(source: HTMLElement, target: HTMLElement) {
		// Handle multi-line content properly
		let isFirstParagraph = true;

		while (source.firstChild) {
			const node = source.firstChild;

			if (node.nodeName === "P") {
				const p = node as HTMLElement;

				if (isFirstParagraph) {
					// First paragraph: extract inline content
					while (p.firstChild) {
						target.appendChild(p.firstChild);
					}
					isFirstParagraph = false;
				} else {
					// Subsequent paragraphs: add line break and content
					target.appendChild(document.createElement("br"));
					target.appendChild(document.createElement("br"));
					while (p.firstChild) {
						target.appendChild(p.firstChild);
					}
				}
				source.removeChild(p);
			} else if (node.nodeName === "UL" || node.nodeName === "OL") {
				// Preserve lists
				target.appendChild(document.createElement("br"));
				target.appendChild(node);
			} else if (node.nodeName === "BLOCKQUOTE") {
				// Preserve blockquotes with styling
				target.appendChild(document.createElement("br"));
				const blockquote = node as HTMLElement;
				blockquote.style.marginLeft = "1em";
				blockquote.style.paddingLeft = "0.5em";
				blockquote.style.borderLeft = "3px solid var(--quote-border)";
				target.appendChild(blockquote);
			} else if (node.nodeName === "PRE") {
				// Preserve code blocks
				target.appendChild(document.createElement("br"));
				target.appendChild(node);
			} else {
				target.appendChild(node);
			}
		}
	}

	renderCommentaryWithFootnotes(
		text: string,
		container: HTMLElement,
		blockId: string
	) {
		// First, render the entire markdown content
		const tempContainer = document.createElement("div");
		MarkdownRenderer.renderMarkdown(text, tempContainer, "", null);

		// Now process the rendered content to replace footnote markers
		const processNode = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const textContent = node.textContent || "";
				const fnRefPattern = /\{\{fnref:(\d+)\}\}/g;

				if (fnRefPattern.test(textContent)) {
					const fragment = document.createDocumentFragment();
					let lastIndex = 0;
					let match;

					fnRefPattern.lastIndex = 0; // Reset regex
					while ((match = fnRefPattern.exec(textContent)) !== null) {
						// Add text before the footnote
						if (match.index > lastIndex) {
							fragment.appendChild(
								document.createTextNode(
									textContent.slice(lastIndex, match.index)
								)
							);
						}

						// Create footnote reference
						const num = match[1];
						const sup = document.createElement("sup");
						sup.className = "footnote-ref";
						const link = document.createElement("a");
						link.textContent = `[${num}]`;
						link.href = `#${blockId}-footnote-${num}`;
						link.id = `${blockId}-ref-${num}`;
						link.addEventListener("click", (e) => {
							e.preventDefault();
							this.scrollToAndHighlight(
								`${blockId}-footnote-${num}`
							);
						});
						sup.appendChild(link);
						fragment.appendChild(sup);

						lastIndex = match.index + match[0].length;
					}

					// Add remaining text
					if (lastIndex < textContent.length) {
						fragment.appendChild(
							document.createTextNode(
								textContent.slice(lastIndex)
							)
						);
					}

					// Replace the text node with the fragment
					if (node.parentNode) {
						node.parentNode.replaceChild(fragment, node);
					}
				}
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				// Recursively process child nodes
				const children = Array.from(node.childNodes);
				children.forEach((child) => processNode(child));
			}
		};

		// Process all nodes in the temporary container
		Array.from(tempContainer.childNodes).forEach((node) =>
			processNode(node)
		);

		// Move processed content to the actual container
		while (tempContainer.firstChild) {
			container.appendChild(tempContainer.firstChild);
		}
	}

	createQuickToolbar(toolbar: HTMLElement, blockId: string) {
		// Copy block ID button
		const copyBtn = toolbar.createEl("button", {
			cls: "toolbar-btn",
			attr: { "aria-label": "Copy Block ID" },
		});
		copyBtn.innerHTML = "🔗";
		copyBtn.addEventListener("click", async () => {
			await navigator.clipboard.writeText(`[[#${blockId}]]`);
			new Notice("Block reference copied!");
		});

		// Export button
		const exportBtn = toolbar.createEl("button", {
			cls: "toolbar-btn",
			attr: { "aria-label": "Export Block" },
		});
		exportBtn.innerHTML = "📤";
		exportBtn.addEventListener("click", () => {
			this.exportBlock(blockId);
		});

		// Statistics button
		if (this.settings.enableStatistics) {
			const statsBtn = toolbar.createEl("button", {
				cls: "toolbar-btn",
				attr: { "aria-label": "Show Statistics" },
			});
			statsBtn.innerHTML = "📊";
			statsBtn.addEventListener("click", () => {
				this.showBlockStatistics(blockId);
			});
		}
	}

	calculateStatistics(
		commentaryText: string,
		footnotesText: string = ""
	): { words: number; footnotes: number } {
		const words = commentaryText
			.split(/\s+/)
			.filter((word) => word.length > 0).length;

		// Count footnote references in commentary using the new syntax: $[1], $[2], etc.
		const footnoteMatches = commentaryText.match(/\$\[(\d+)\]/g);
		const footnotes = footnoteMatches?.length || 0;

		return { words, footnotes };
	}

	exportBlock(blockId: string) {
		const blockData = this.blockRegistry.get(blockId);
		if (!blockData) return;

		const exportContent = `# Commentary Block Export\n\n## Original Text\n${
			blockData.originalText
		}\n\n## Commentary\n${blockData.commentary}\n\n## Footnotes\n${
			blockData.footnotes || ""
		}`;

		const blob = new Blob([exportContent], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `commentary-block-${blockId}.md`;
		a.click();
		URL.revokeObjectURL(url);

		new Notice("Block exported successfully!");
	}

	showBlockStatistics(blockId: string) {
		const blockData = this.blockRegistry.get(blockId);
		if (!blockData) return;

		const stats = this.calculateStatistics(
			blockData.commentary,
			blockData.footnotes
		);
		const originalStats = this.calculateStatistics(blockData.originalText);

		new Notice(`📊 Block Statistics:
Original Text: ${originalStats.words} words
Commentary: ${stats.words} words
Footnotes: ${stats.footnotes}
Ratio: ${(stats.words / originalStats.words).toFixed(2)}x`);
	}

	toggleAllBlocks() {
		const blocks = document.querySelectorAll(".commentary-block-content");
		const shouldCollapse = !document.querySelector(
			".commentary-block-content.collapsed"
		);

		blocks.forEach((block) => {
			if (shouldCollapse) {
				block.classList.add("collapsed");
			} else {
				block.classList.remove("collapsed");
			}

			const btn = block.parentElement?.querySelector(
				".commentary-collapse-btn"
			);
			if (btn) {
				btn.textContent = shouldCollapse ? "▶" : "▼";
			}
		});

		new Notice(`All blocks ${shouldCollapse ? "collapsed" : "expanded"}`);
	}

	scrollToAndHighlight(elementId: string) {
		const element = document.getElementById(elementId);
		if (element) {
			element.scrollIntoView({ behavior: "smooth", block: "center" });
			element.classList.add("highlight-flash");
			setTimeout(() => {
				element.classList.remove("highlight-flash");
			}, this.settings.highlightDuration);
		}
	}

	insertCommentaryBlock(editor: Editor) {
		const template = `\`\`\`commentary
---metadata---
title: Commentary on [Topic]
tags: analysis, notes

---text---
[Insert the original text to comment on here / متن اصلی را اینجا وارد کنید]

---commentary---
Your commentary goes here. Use Ctrl+Shift+F to add footnotes $[1] anywhere in your text.

---footnote---
$[1]: This is a footnote definition. You can use different types like note:, warning:, info:, reference:, idea:, or question: before your content.
\`\`\``;

		editor.replaceSelection(template);
	}

	insertFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		// Check if we're inside a commentary block
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice(
				"Place cursor inside a commentary block to insert a footnote"
			);
			return;
		}

		// Check if cursor is in a footnote definition
		const footnoteNavigation = this.checkFootnoteNavigation(editor, cursor);
		if (footnoteNavigation) {
			if (footnoteNavigation.inFootnoteSection) {
				// We're in footnote section, navigate to reference
				this.navigateToFootnoteReference(
					editor,
					footnoteNavigation.number
				);
			} else {
				// We're in commentary section on a reference, navigate to definition
				this.navigateToFootnoteDefinition(
					editor,
					footnoteNavigation.number
				);
			}
			return;
		}

		// Find the next available footnote number within this block
		const nextNumber = this.getNextFootnoteNumberInBlock(
			editor,
			blockBounds
		);

		// Insert the reference at cursor position
		const reference = `$[${nextNumber}]`;
		editor.replaceSelection(reference);

		// Find the end of the commentary section to add the definition
		const definitionTemplate = `$[${nextNumber}]: ${this.settings.defaultFootnoteType}:`;
		const cursorPosition = this.addFootnoteDefinitionToBlock(
			editor,
			definitionTemplate,
			blockBounds
		);

		// Move cursor to the footnote definition area
		if (cursorPosition) {
			// Position cursor after the type and colon, ready for content
			const typeLength = this.settings.defaultFootnoteType.length;
			editor.setCursor({
				line: cursorPosition.line,
				ch:
					cursorPosition.ch +
					`$[${nextNumber}]: ${this.settings.defaultFootnoteType}:`
						.length,
			});
		}

		new Notice(
			`Footnote ${nextNumber} inserted. Start typing the definition.`
		);
	}

	insertMultilineFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice(
				"Place cursor inside a commentary block to insert a footnote"
			);
			return;
		}

		// Check if cursor is in a footnote definition
		const footnoteNavigation = this.checkFootnoteNavigation(editor, cursor);
		if (footnoteNavigation) {
			if (footnoteNavigation.inFootnoteSection) {
				// We're in footnote section, navigate to reference
				this.navigateToFootnoteReference(
					editor,
					footnoteNavigation.number
				);
			} else {
				// We're in commentary section on a reference, navigate to definition
				this.navigateToFootnoteDefinition(
					editor,
					footnoteNavigation.number
				);
			}
			return;
		}

		// Find the next available footnote number within this block
		const nextNumber = this.getNextFootnoteNumberInBlock(
			editor,
			blockBounds
		);

		// Insert the reference at cursor position
		const reference = `$[${nextNumber}]`;
		editor.replaceSelection(reference);

		// Add multi-line definition template
		const definitionTemplate = `$[${nextNumber}]: ${this.settings.defaultFootnoteType}:Multi-line footnote content here.
Continue writing on multiple lines as needed.`;
		const cursorPosition = this.addFootnoteDefinitionToBlock(
			editor,
			definitionTemplate,
			blockBounds
		);

		// Move cursor to the footnote definition area, specifically to select the placeholder text
		if (cursorPosition) {
			const typeLength = this.settings.defaultFootnoteType.length;
			const prefixLength =
				`$[${nextNumber}]: ${this.settings.defaultFootnoteType}:`
					.length;

			// Select the placeholder text "Multi-line footnote content here."
			editor.setSelection(
				{
					line: cursorPosition.line,
					ch: cursorPosition.ch + prefixLength,
				},
				{
					line: cursorPosition.line,
					ch:
						cursorPosition.ch +
						prefixLength +
						"Multi-line footnote content here.".length,
				}
			);
		}

		new Notice(
			`Multi-line footnote ${nextNumber} inserted. Replace the placeholder text.`
		);
	}

	handleFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		// Check if we're inside a commentary block
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice(
				"Place cursor inside a commentary block to use footnotes"
			);
			return;
		}

		// Check if cursor is on an existing footnote (reference or definition)
		const footnoteNavigation = this.checkFootnoteNavigation(editor, cursor);
		if (footnoteNavigation) {
			if (footnoteNavigation.inFootnoteSection) {
				// We're in footnote section, navigate to reference
				this.navigateToFootnoteReference(
					editor,
					footnoteNavigation.number
				);
			} else {
				// We're in commentary section on a reference, navigate to definition
				this.navigateToFootnoteDefinition(
					editor,
					footnoteNavigation.number
				);
			}
			return;
		}

		// No existing footnote found, create a new one
		this.createNewFootnote(editor, cursor);
	}

	createNewFootnote(editor: Editor, cursor: { line: number; ch: number }) {
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice(
				"Place cursor inside a commentary block to create footnotes"
			);
			return;
		}

		// Find the next available footnote number within this block
		const nextNumber = this.getNextFootnoteNumberInBlock(
			editor,
			blockBounds
		);

		// Insert the reference at cursor position
		const reference = `$[${nextNumber}]`;
		editor.replaceSelection(reference);

		// Create the definition template
		const definitionTemplate = `$[${nextNumber}]: ${this.settings.defaultFootnoteType}:`;
		const cursorPosition = this.addFootnoteDefinitionToBlock(
			editor,
			definitionTemplate,
			blockBounds
		);

		// Move cursor to the footnote definition area
		if (cursorPosition) {
			// Position cursor after the type and colon, ready for content
			editor.setCursor({
				line: cursorPosition.line,
				ch:
					cursorPosition.ch +
					`$[${nextNumber}]: ${this.settings.defaultFootnoteType}:`
						.length,
			});
		}

		new Notice(
			`Footnote ${nextNumber} created. Start typing the definition.`
		);
	}

	// UPDATED: Only look for footnotes within the current commentary block
	getNextFootnoteNumberInBlock(
		editor: Editor,
		blockBounds: CommentaryBlockBounds
	): number {
		const lines = editor.getValue().split("\n");
		const footnoteRefs: number[] = [];

		// Only scan within the current block boundaries
		for (
			let i = blockBounds.startLine;
			i < Math.min(blockBounds.endLine, lines.length);
			i++
		) {
			const line = lines[i];
			const matches = line.match(/\$\[(\d+)\]/g);
			if (matches) {
				matches.forEach((match) => {
					const numMatch = match.match(/\$\[(\d+)\]/);
					if (numMatch) {
						footnoteRefs.push(parseInt(numMatch[1]));
					}
				});
			}
		}

		return footnoteRefs.length > 0 ? Math.max(...footnoteRefs) + 1 : 1;
	}

	checkFootnoteNavigation(
		editor: Editor,
		cursor: { line: number; ch: number }
	): { number: number; inFootnoteSection: boolean } | null {
		const currentLine = editor.getLine(cursor.line);

		// Check if current line is a footnote definition: $[1]: content
		const footnoteDefMatch = currentLine.match(/^\$\[(\d+)\]:/);
		if (footnoteDefMatch) {
			const footnoteNumber = parseInt(footnoteDefMatch[1]);
			const inFootnoteSection = this.isInFootnoteSection(
				editor,
				cursor.line
			);

			return {
				number: footnoteNumber,
				inFootnoteSection: inFootnoteSection,
			};
		}

		// Check if cursor is on a footnote reference: $[1]
		const footnoteRefPattern = /\$\[(\d+)\]/g;
		let match;

		while ((match = footnoteRefPattern.exec(currentLine)) !== null) {
			const startPos = match.index;
			const endPos = match.index + match[0].length;

			// Check if cursor is within this footnote reference
			if (cursor.ch >= startPos && cursor.ch <= endPos) {
				const footnoteNumber = parseInt(match[1]);
				const inFootnoteSection = this.isInFootnoteSection(
					editor,
					cursor.line
				);

				return {
					number: footnoteNumber,
					inFootnoteSection: inFootnoteSection,
				};
			}
		}

		return null;
	}

	isInFootnoteSection(editor: Editor, line: number): boolean {
		// Look backwards from current line to find section markers
		for (let i = line; i >= 0; i--) {
			const checkLine = editor.getLine(i);

			if (checkLine.startsWith("---footnote---")) {
				return true;
			}

			if (
				checkLine.startsWith("---commentary---") ||
				checkLine.startsWith("---text---") ||
				checkLine.startsWith("---metadata---")
			) {
				return false;
			}

			if (checkLine.startsWith("```")) {
				return false;
			}
		}

		return false;
	}

	navigateFootnote(editor: Editor) {
		const cursor = editor.getCursor();

		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice(
				"Place cursor inside a commentary block to navigate footnotes"
			);
			return;
		}

		// Check if we're in a footnote definition
		const footnoteNavigation = this.checkFootnoteNavigation(editor, cursor);
		if (footnoteNavigation) {
			if (footnoteNavigation.inFootnoteSection) {
				// We're in footnote section, navigate to reference
				this.navigateToFootnoteReference(
					editor,
					footnoteNavigation.number
				);
			} else {
				// We're in commentary section, navigate to definition
				this.navigateToFootnoteDefinition(
					editor,
					footnoteNavigation.number
				);
			}
			return;
		}

		// Check if cursor is on a footnote reference in commentary
		const currentLine = editor.getLine(cursor.line);
		const footnoteRefPattern = /\$\[(\d+)\]/g;
		let match;

		while ((match = footnoteRefPattern.exec(currentLine)) !== null) {
			const startPos = match.index;
			const endPos = match.index + match[0].length;

			// Check if cursor is within this footnote reference
			if (cursor.ch >= startPos && cursor.ch <= endPos) {
				const footnoteNumber = parseInt(match[1]);
				this.navigateToFootnoteDefinition(editor, footnoteNumber);
				return;
			}
		}

		new Notice(
			"Place cursor on a footnote reference or definition to navigate"
		);
	}

	// UPDATED: Only search within the current commentary block
	navigateToFootnoteDefinition(editor: Editor, footnoteNumber: number) {
		const cursor = editor.getCursor();
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice("Not in a commentary block");
			return;
		}

		const lines = editor.getValue().split("\n");

		// Only search within the current block's footnote section
		if (
			blockBounds.footnoteStart !== undefined &&
			blockBounds.footnoteEnd !== undefined
		) {
			for (
				let i = blockBounds.footnoteStart + 1;
				i < blockBounds.footnoteEnd;
				i++
			) {
				const line = lines[i];
				const definitionPattern = new RegExp(
					`^\\$\\[${footnoteNumber}\\]:`
				);
				const match = definitionPattern.exec(line);

				if (match) {
					// Found the definition, move cursor to it
					const position = {
						line: i,
						ch: match[0].length, // Position after the colon
					};

					editor.setCursor(position);
					editor.scrollIntoView({
						from: position,
						to: position,
					});

					new Notice(
						`Jumped to footnote ${footnoteNumber} definition.`
					);
					return;
				}
			}
		}

		new Notice(
			`Footnote ${footnoteNumber} definition not found in this block.`
		);
	}

	// UPDATED: Only search within the current commentary block
	navigateToFootnoteReference(editor: Editor, footnoteNumber: number) {
		const cursor = editor.getCursor();
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (!blockBounds) {
			new Notice("Not in a commentary block");
			return;
		}

		const lines = editor.getValue().split("\n");

		// Only search within the current block's commentary section
		if (
			blockBounds.commentaryStart !== undefined &&
			blockBounds.commentaryEnd !== undefined
		) {
			for (
				let i = blockBounds.commentaryStart + 1;
				i < blockBounds.commentaryEnd;
				i++
			) {
				const line = lines[i];
				const referencePattern = new RegExp(
					`\\$\\[${footnoteNumber}\\]`
				);
				const match = referencePattern.exec(line);

				if (match) {
					const position = { line: i, ch: match.index };
					editor.setCursor(position);
					editor.scrollIntoView({
						from: position,
						to: {
							line: position.line,
							ch: position.ch + match[0].length,
						},
					});
					new Notice(
						`Jumped to footnote ${footnoteNumber} reference in commentary.`
					);
					return;
				}
			}
		}

		new Notice(
			`Footnote ${footnoteNumber} reference not found in this block's commentary section.`
		);
	}

	// DEPRECATED: Use getNextFootnoteNumberInBlock instead
	getNextFootnoteNumber(editor: Editor): number {
		const cursor = editor.getCursor();
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (blockBounds) {
			return this.getNextFootnoteNumberInBlock(editor, blockBounds);
		}

		// Fallback to old behavior if not in a block
		const content = editor.getValue();
		const footnoteRefs = content.match(/\$\[(\d+)\]/g) || [];
		const footnoteNums = footnoteRefs.map((ref) => {
			const match = ref.match(/\$\[(\d+)\]/);
			return match ? parseInt(match[1]) : 0;
		});

		return footnoteNums.length > 0 ? Math.max(...footnoteNums) + 1 : 1;
	}

	// UPDATED: Add footnote definition to the specific block only
	addFootnoteDefinitionToBlock(
		editor: Editor,
		definition: string,
		blockBounds: CommentaryBlockBounds
	): { line: number; ch: number } | null {
		const lines = editor.getValue().split("\n");
		let insertLine = -1;

		if (blockBounds.footnoteStart !== undefined) {
			// Add to existing footnote section
			insertLine = blockBounds.footnoteEnd || blockBounds.endLine;
		} else {
			// Create footnote section before the end of the block
			insertLine = blockBounds.endLine;

			// Insert the footnote section header and definition
			const newLines = [
				...lines.slice(0, insertLine),
				"",
				"---footnote---",
				definition,
				...lines.slice(insertLine),
			];

			editor.setValue(newLines.join("\n"));

			// Return position for the inserted definition
			return { line: insertLine + 2, ch: 0 }; // +2 for empty line and section header
		}

		// Insert just the definition in existing footnote section
		const newLines = [
			...lines.slice(0, insertLine),
			definition,
			...lines.slice(insertLine),
		];

		editor.setValue(newLines.join("\n"));

		// Return position for the inserted definition
		return { line: insertLine, ch: 0 };
	}

	// DEPRECATED: Use addFootnoteDefinitionToBlock instead
	addFootnoteDefinition(
		editor: Editor,
		definition: string
	): { line: number; ch: number } | null {
		const cursor = editor.getCursor();
		const blockBounds = this.getCurrentCommentaryBlockBounds(
			editor,
			cursor.line
		);
		if (blockBounds) {
			return this.addFootnoteDefinitionToBlock(
				editor,
				definition,
				blockBounds
			);
		}

		// Fallback to old behavior
		const content = editor.getValue();
		const lines = content.split("\n");

		// Find the footnote section or the end of the commentary block
		let footnoteStart = -1;
		let blockEnd = -1;
		let inCommentaryBlock = false;
		let insertLine = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (line.startsWith("```commentary")) {
				inCommentaryBlock = true;
				continue;
			}

			if (inCommentaryBlock && line.startsWith("```")) {
				blockEnd = i;
				break;
			}

			if (inCommentaryBlock && line.startsWith("---footnote---")) {
				footnoteStart = i;
				continue;
			}
		}

		let newContent;

		if (footnoteStart > 0) {
			// Add to existing footnote section
			insertLine = blockEnd > 0 ? blockEnd : lines.length;
			newContent = [
				...lines.slice(0, insertLine),
				definition,
				...lines.slice(insertLine),
			].join("\n");
		} else if (blockEnd > 0) {
			// Create footnote section
			insertLine = blockEnd;
			newContent = [
				...lines.slice(0, blockEnd),
				"",
				"---footnote---",
				definition,
				...lines.slice(blockEnd),
			].join("\n");
			// Adjust insert line for the new section header
			insertLine += 2; // Account for empty line and ---footnote--- line
		} else {
			// Fallback: add at the end
			insertLine = lines.length;
			newContent = content + "\n\n---footnote---\n" + definition;
			insertLine += 2; // Account for empty line and ---footnote--- line
		}

		editor.setValue(newContent);

		// Return the cursor position for the inserted definition
		return { line: insertLine, ch: 0 };
	}

	isInCommentaryBlock(editor: Editor, line: number): boolean {
		return this.getCurrentCommentaryBlockBounds(editor, line) !== null;
	}

	addStyles() {
		const style = document.createElement("style");
		style.textContent = `
            .commentary-block-container {
                border: 1px solid var(--background-modifier-border);
                border-radius: 8px;
                margin: 1em 0;
                padding: 0;
                background: var(--background-primary);
                position: relative;
            }
            
            .commentary-block-tags {
                padding: 8px 15px;
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }
            
            .commentary-tag {
                display: inline-block;
                padding: 2px 8px;
                background: var(--tag-background);
                color: var(--tag-color);
                border-radius: 12px;
                font-size: 0.85em;
                cursor: pointer;
                transition: opacity 0.2s;
            }
            
            .commentary-tag:hover {
                opacity: 0.8;
            }
            
            .commentary-block-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 15px;
                background: var(--background-secondary);
                border-radius: 8px 8px 0 0;
                cursor: pointer;
                user-select: none;
            }
            
            .commentary-collapse-btn {
                background: none;
                border: none;
                cursor: pointer;
                font-size: 12px;
                margin-right: 10px;
				margin-left: 0;
                padding: 0;
                width: 20px;
                color: var(--text-muted);
                transition: transform 0.2s;
            }

			.is-rtl .commentary-collapse-btn {
				margin-left: 10px;
				margin-right: 0;
			}
            
            .commentary-collapse-btn:hover {
                color: var(--text-normal);
            }
            
            .commentary-block-title {
                font-weight: 600;
                color: var(--text-normal);
                flex-grow: 1;
            }
            
            .commentary-toolbar {
                display: flex;
                gap: 5px;
                margin-left: auto;
            }
            
            .toolbar-btn {
                background: none;
                border: none;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 14px;
                transition: background 0.2s;
            }
            
            .toolbar-btn:hover {
                background: var(--background-modifier-hover);
            }
            
            .commentary-block-content {
                padding: 15px;
                max-height: 3000px;
                overflow: hidden;
                transition: max-height 0.3s ease-out, padding 0.3s ease-out;
            }
            
            .commentary-block-content.collapsed {
                max-height: 0;
                padding: 0 15px;
            }
            
            .commentary-original-text {
                background: var(--background-secondary-alt);
                border-radius: 6px;
                padding: 12px;
                margin-bottom: 15px;
                border-left: 3px solid var(--quote-border);
            }
            
            .commentary-original-text h4 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            
            .original-text-content {
                color: var(--text-normal);
                font-style: italic;
            }
            
            .commentary-section h4 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.9em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                display: flex;
                align-items: center;
            }
            
            .commentary-stats {
                font-size: 0.85em;
                color: var(--text-faint);
                font-weight: normal;
                margin-left: 10px;
            }
            
            .commentary-content {
                color: var(--text-normal);
            }
            
            .commentary-body {
                line-height: 1.6;
            }
            
            .commentary-body p {
                margin-top: 0;
                margin-bottom: 1em;
            }
            
            .commentary-body p:last-child {
                margin-bottom: 0;
            }
            
            
            .footnote-ref {
                margin: 0;
                display: inline;
                vertical-align: super;
            }
            
            
            .footnote-ref a {
                color: var(--link-color);
                text-decoration: none;
                font-weight: 600;
                padding: 0;
                display: inline;
                transition: all 0.2s;
            }
            
            .footnote-ref a:hover {
                color: var(--link-color-hover);
                text-decoration: underline;
                background: var(--background-modifier-hover);
                border-radius: 3px;
            }
            
            .commentary-footnotes {
                margin-top: 20px;
                padding-top: 15px;
                border-top: 1px solid var(--background-modifier-border);
            }
            
            .commentary-footnotes h5 {
                margin-top: 0;
                margin-bottom: 10px;
                color: var(--text-muted);
                font-size: 0.85em;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            
            .footnotes-list {
                margin: 0;
                padding-left: 20px;
                font-size: 0.9em;
            }
            
            .footnotes-list li {
                margin-bottom: 12px;
                color: var(--text-muted);
                line-height: 1.5;
            }
            
            .footnote-type-icon {
                display: inline;
                margin-right: 4px;
            }
            
            .footnote-text {
                display: inline;
                color: var(--text-normal);
            }
            
            .footnote-text p {
                display: inline;
                margin: 0;
            }
            
            .footnote-text br + br {
                display: block;
                content: "";
                margin: 0.5em 0;
            }
            
            .footnote-text ul,
            .footnote-text ol {
                margin: 0.5em 0;
                padding-left: 1.5em;
            }
            
            .footnote-text blockquote {
                margin: 0.5em 0;
                padding-left: 1em;
                border-left: 3px solid var(--quote-border);
            }
            
            .footnote-text pre {
                margin: 0.5em 0;
                padding: 0.5em;
                background: var(--code-background);
                border-radius: 4px;
            }
            
            .footnote-backref {
                color: var(--link-color);
                text-decoration: none;
                margin-right: 5px;
                font-size: 0.9em;
                transition: all 0.2s;
            }
            
            .footnote-backref:hover {
                color: var(--link-color-hover);
                transform: translateX(-2px);
            }
            
            .highlight-flash {
                animation: highlightFlash 2s ease-out;
            }
            
            @keyframes highlightFlash {
                0% {
                    background-color: var(--interactive-accent);
                    opacity: 0.3;
                    transform: scale(1.05);
                }
                50% {
                    transform: scale(1);
                }
                100% {
                    background-color: transparent;
                    opacity: 1;
                }
            }
            
            /* Mobile compatibility */
            @media (max-width: 768px) {
                .commentary-block-container {
                    margin: 0.5em 0;
                }
                
                .commentary-block-header {
                    padding: 8px 12px;
                    flex-direction: column;
                    align-items: flex-start;
                }
                
                .commentary-toolbar {
                    margin-top: 8px;
                    margin-left: 0;
                }
                
                .commentary-block-content {
                    padding: 12px;
                }
                
                .commentary-original-text,
                .commentary-section {
                    padding: 10px;
                }
                
                .footnotes-list {
                    padding-left: 15px;
                }
            }
            
            /* Dark mode enhancements */
            .theme-dark .commentary-block-container {
                background: var(--background-primary);
                border-color: var(--background-modifier-border);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            }
            
            .theme-dark .commentary-block-header {
                background: var(--background-secondary);
            }
            
            .theme-dark .commentary-original-text {
                background: var(--background-secondary-alt);
            }
            
            .theme-dark .commentary-tag {
                background: var(--background-modifier-hover);
                color: var(--text-normal);
            }
            
            /* Print styles */
            @media print {
                .commentary-toolbar,
                .commentary-collapse-btn {
                    display: none !important;
                }
                
                .commentary-block-content {
                    max-height: none !important;
                    padding: 15px !important;
                }
                
                .commentary-block-content.collapsed {
                    max-height: none !important;
                }
            }
        `;
		document.head.appendChild(style);
	}

	onunload() {
		// Cleanup
		this.blockRegistry.clear();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CommentarySettingTab extends PluginSettingTab {
	plugin: CommentaryPlugin;

	constructor(app: App, plugin: CommentaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Commentary Plugin Settings" });

		new Setting(containerEl)
			.setName("Default Collapsed State")
			.setDesc("Whether commentary blocks should be collapsed by default")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.defaultCollapsed)
					.onChange(async (value) => {
						this.plugin.settings.defaultCollapsed = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Quick Toolbar")
			.setDesc("Show quick action buttons in block headers")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableQuickToolbar)
					.onChange(async (value) => {
						this.plugin.settings.enableQuickToolbar = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Statistics")
			.setDesc("Show word and footnote counts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStatistics)
					.onChange(async (value) => {
						this.plugin.settings.enableStatistics = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable Block Tags")
			.setDesc("Allow tagging commentary blocks for organization")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableBlockTags)
					.onChange(async (value) => {
						this.plugin.settings.enableBlockTags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default Footnote Type")
			.setDesc("Default type for new footnotes")
			.addDropdown((dropdown) => {
				Object.keys(FOOTNOTE_TYPES).forEach((type) => {
					dropdown.addOption(type, type);
				});
				dropdown
					.setValue(this.plugin.settings.defaultFootnoteType)
					.onChange(async (value) => {
						this.plugin.settings.defaultFootnoteType = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Highlight Duration")
			.setDesc(
				"Duration of the highlight animation when jumping to footnotes (in milliseconds)"
			)
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.highlightDuration))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.highlightDuration = num;
							await this.plugin.saveSettings();
						}
					})
			);

		containerEl.createEl("h3", { text: "Keyboard Shortcuts" });
		const shortcutsEl = containerEl.createEl("div", {
			cls: "setting-item-description",
		});

		shortcutsEl.innerHTML = `
            <ul>
                <li><code>Ctrl+Shift+C</code> - Insert new commentary block</li>
                <li><code>Ctrl+Shift+F</code> - Smart footnote command:
                    <ul>
                        <li>In empty space → Create new footnote + jump to definition</li>
                        <li>On footnote reference → Jump to definition</li>
                        <li>On footnote definition → Jump to reference</li>
                    </ul>
                </li>
                <li>Use command palette for: Toggle all blocks</li>
            </ul>
        `;

		containerEl.createEl("h3", { text: "How to Use Footnotes" });
		const usageEl = containerEl.createEl("div", {
			cls: "setting-item-description",
		});
		usageEl.innerHTML = `
            <p><strong>One Command Does Everything:</strong> <code>Ctrl+Shift+F</code></p>
            <ul>
                <li><strong>Create footnote:</strong> Place cursor anywhere in commentary text and press the shortcut</li>
                <li><strong>Jump to definition:</strong> Place cursor on any footnote reference like <code>$[1]</code> and press the shortcut</li>
                <li><strong>Jump to reference:</strong> Place cursor on any footnote definition and press the shortcut</li>
            </ul>
            <p><strong>Footnote Structure:</strong></p>
            <pre>---commentary---
This text has a footnote $[1] here.

---footnote---
$[1]: The footnote definition goes here.</pre>
        `;

		containerEl.createEl("h3", { text: "Footnote Syntax" });
		const syntaxEl = containerEl.createEl("div", {
			cls: "setting-item-description",
		});
		syntaxEl.innerHTML = `
            <p><strong>Block Structure:</strong></p>
            <pre>---commentary---
This is text with a footnote $[1] and another $[2].

---footnote---
$[1]: This is the first footnote.
$[2]: This is the second footnote.</pre>
            <p><strong>Footnote Reference:</strong> <code>$[1]</code>, <code>$[2]</code>, etc.</p>
            <p><strong>Footnote Definition:</strong> <code>$[1]: Your footnote content here</code></p>
            <p><strong>Typed footnotes:</strong></p>
            <ul>
                <li>📝 Note: <code>$[1]: note:Text</code></li>
                <li>⚠️ Warning: <code>$[2]: warning:Text</code></li>
                <li>ℹ️ Info: <code>$[3]: info:Text</code></li>
                <li>📚 Reference: <code>$[4]: reference:Text</code></li>
                <li>💡 Idea: <code>$[5]: idea:Text</code></li>
                <li>❓ Question: <code>$[6]: question:Text</code></li>
            </ul>
            <p><strong>Multi-line footnotes:</strong></p>
            <pre>$[1]: This is a multi-line footnote
that can span multiple lines naturally.
Just continue writing on the next lines.</pre>
        `;
	}
}

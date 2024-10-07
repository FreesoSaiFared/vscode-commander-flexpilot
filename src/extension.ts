// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vscode-commander" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('vscode-commander.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from vscode-commander!');
	});

	context.subscriptions.push(disposable);

	// Create a chat participant
	const chatParticipant = vscode.chat.createChatParticipant('c', async (request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		const [model] = await vscode.lm.selectChatModels({
			family: 'gpt-4o',
		});

		const tools = vscode.lm.tools
			.filter(t => t.tags.includes('commander'))
			.map<vscode.LanguageModelChatTool>(t => ({
				name: t.id,
				description: t.description,
				parametersSchema: t.parametersSchema
			}));

		const messages = [
			vscode.LanguageModelChatMessage.User('You are a VS Code commander and your goal is to update settings by using the provided tools. Make sure the setting exists. Do not update the setting if you wont update the value. Never ask the user whether they think you should update the setting, just do it.'),
		];

		for (const history of context.history) {
			if (history instanceof vscode.ChatRequestTurn) {
				messages.push(vscode.LanguageModelChatMessage.User(history.prompt));
			}

			if (history instanceof vscode.ChatResponseTurn) {
				for (const response of history.response) {
					if (response instanceof vscode.ChatResponseMarkdownPart) {
						messages.push(vscode.LanguageModelChatMessage.Assistant(response.value.value));
					}
				}
			}
		}

		messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

		await invokeModelWithTools(messages, model, tools, request, response, token);

	});

	context.subscriptions.push(vscode.lm.registerTool('searchSettings', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<void>, token: vscode.CancellationToken) {
			return {
				'application/json': JSON.stringify([{
					id: 'editor.fontSize',
					value: vscode.workspace.getConfiguration().get('editor.fontSize'),
					defaultValue: 12,
					type: 'string'
				}]),
			};
		},
	}));

	context.subscriptions.push(vscode.lm.registerTool('updateSetting', {
		async invoke(options: vscode.LanguageModelToolInvocationOptions<{ key: string, value: any }>, token: vscode.CancellationToken) {
			if (options.parameters.key && options.parameters.value) {
				await vscode.workspace.getConfiguration().update(options.parameters.key, options.parameters.value, vscode.ConfigurationTarget.Global);
				return {
					'text/plain': 'Changed',
				};
			}
			return {
				'text/plain': 'Not able to change because the parameter is missing',
			};
		},
	}));

	context.subscriptions.push(chatParticipant);
}

interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelChatResponseToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

async function invokeModelWithTools(initialMessages: vscode.LanguageModelChatMessage[], model: vscode.LanguageModelChat, tools: vscode.LanguageModelChatTool[], request: vscode.ChatRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken) {

	const messages = [...initialMessages];
	const toolCalls: IToolCall[] = [];

	const modelResponse = await model.sendRequest(messages, { tools });

	try {
		for await (const message of modelResponse.stream) {

			if (message instanceof vscode.LanguageModelChatResponseTextPart) {
				response.markdown(message.value);
			}

			else if (message instanceof vscode.LanguageModelChatResponseToolCallPart) {
				const tool = vscode.lm.tools.find(t => t.id === message.name);
				if (!tool) {
					continue;
				}
				// TODO support prompt-tsx here
				const requestedContentType = 'text/plain';

				let parameters = undefined;
				if (tool.parametersSchema) {
					if (message.parameters) {
						try {
							parameters = JSON.parse(message.parameters);
						} catch (e) {
							console.warn('Failed to parse parameters for tool', tool.id, message.parameters);
							continue;
						}
					}
				}

				toolCalls.push({
					call: message,
					result: vscode.lm.invokeTool(tool.id, {
						toolInvocationToken: request.toolInvocationToken,
						requestedContentTypes: ['text/plain', 'application/json'],
						parameters
					}, token),
					tool
				});
			}
		}
	} catch (e) {
		console.error('Error invoking model with tools', e);
		throw e;
	}

	if (toolCalls.length) {
		const assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
		assistantMsg.content2 = toolCalls.map(toolCall => new vscode.LanguageModelChatResponseToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters));
		messages.push(assistantMsg);
		for (const toolCall of toolCalls) {
			// NOTE that the result of calling a function is a special content type of a USER-message
			const message = vscode.LanguageModelChatMessage.User('');

			const toolResult = await toolCall.result;
			message.content2 = [new vscode.LanguageModelChatMessageToolResultPart(toolCall.call.toolCallId, toolResult['application/json'] ?? toolResult['text/plain'])];
			messages.push(message);
		}

		// IMPORTANT The prompt must end with a USER message (with no tool call)
		messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));

		return invokeModelWithTools(messages, model, tools, request, response, token);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }

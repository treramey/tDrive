import { convertDocx } from './docx-converter';
import type { DocxWorkerResult } from './docx-preview';

self.onmessage = async (event: MessageEvent<unknown>) => {
	const result: DocxWorkerResult =
		event.data instanceof ArrayBuffer
			? await convertDocx(event.data)
			: { kind: 'error' };

	self.postMessage(result);
};

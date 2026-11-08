import path from 'node:path';
import os from 'node:os';
const profile = process.env.AFTERSHELF_DATA;
if (!profile || !path.basename(profile).startsWith('aftershelf-main-sources-') || path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir())) throw new Error('This fixture must run through the parent native test with its generated temporary profile.');

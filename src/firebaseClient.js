import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  query,
  where,
  onSnapshot,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutUser() {
  await signOut(auth);
}

export function subscribeToAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export function subscribeToCloudRepoHistory(user, onUpdate) {
  if (!user || !user.uid) return () => {};
  const path = 'repoHistory';
  const q = query(collection(db, path), where('ownerId', '==', user.uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        let parsedFiles = [];
        try {
          parsedFiles = JSON.parse(d.filesPayload || '[]');
        } catch {
          parsedFiles = [];
        }
        items.push({
          id: docSnap.id,
          name: d.name,
          description: d.description || '',
          repoUrl: d.repoUrl || '',
          language: d.language || 'Unknown',
          fileCount: Number(d.fileCount || parsedFiles.length || 1),
          files: parsedFiles,
          updatedAt:
            d.updatedAt && typeof d.updatedAt.toDate === 'function'
              ? d.updatedAt.toDate().toISOString()
              : new Date().toISOString(),
          source: 'firestore',
        });
      });
      items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      onUpdate(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function saveRepoToFirestore(record) {
  const user = auth.currentUser;
  if (!user || !user.uid || !user.emailVerified) return null;

  const cleanId = String(record.id || `repo-${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 128);
  const path = `repoHistory/${cleanId}`;

  const serializedFiles = JSON.stringify(
    (record.files || []).map((f) => ({
      path: String(f.path || 'src/main.py').slice(0, 240),
      content: String(f.content || '').slice(0, 35000),
    }))
  ).slice(0, 890000);

  const payload = {
    ownerId: String(user.uid).slice(0, 128),
    name: String(record.name || 'unnamed-repo').slice(0, 120),
    description: String(record.description || '').slice(0, 500),
    repoUrl: String(record.repoUrl || '').slice(0, 500),
    language: String(record.language || 'Unknown').slice(0, 60),
    fileCount: Math.max(1, Math.min(500, Number(record.fileCount || record.files?.length || 1))),
    filesPayload: serializedFiles.length >= 2 ? serializedFiles : '[]',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'repoHistory', cleanId), payload);
    return cleanId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return null;
  }
}

export async function deleteRepoFromFirestore(repoId) {
  const user = auth.currentUser;
  if (!user || !user.uid) return;
  const cleanId = String(repoId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  const path = `repoHistory/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'repoHistory', cleanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

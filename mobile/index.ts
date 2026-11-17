import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import App from './App';

// Expo AuthSession returns a web OAuth popup to this same-origin /app callback. Complete the
// redirect before React renders, otherwise Google sign-in looks like it succeeded but stays open.
if (Platform.OS === 'web') WebBrowser.maybeCompleteAuthSession();

registerRootComponent(App);

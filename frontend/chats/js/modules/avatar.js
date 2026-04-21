/**
 * Utility for generating avatars for users without profile pictures.
 */

const AVATAR_COLORS = [
  "#FFADAD", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF", // Pastels
  "#E57373", "#F06292", "#BA68C8", "#9575CD", "#7986CB", "#64B5F6", "#4FC3F7", "#4DD0E1", // Material 300-400
  "#4DB6AC", "#81C784", "#AED581", "#DCE775", "#FFD54F", "#FFB74D", "#FF8A65", "#A1887F",
  "#F48FB1", "#CE93D8", "#B39DDB", "#9FA8DA", "#90CAF9", "#81D4FA", "#80DEEA", "#80CBC4"  // More pleasant colors
];

/**
 * Generates a color based on a string (e.g., username or email).
 * Consistent for the same string.
 * @param {string} str - The string to hash.
 * @returns {string} Hex color code.
 */
export function getAvatarColor(str) {
  if (!str) return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash % AVATAR_COLORS.length);
  return AVATAR_COLORS[index];
}

/**
 * Generates an SVG data URL for a user avatar with initials.
 * @param {string} name - The display name to get initials from.
 * @param {string} id - The unique ID (or email/username) to determine color.
 * @param {number} size - Size of the avatar (default 100).
 * @returns {string} Data URL of the SVG.
 */
export function generateAvatar(name, id, size = 100) {
  let displayName = name || "?";
  let color;

  // Check if user is in contacts (using id as email)
  // We check window.CONTACTS_BY_EMAIL which is populated in main.js
  const isContact = id && window.CONTACTS_BY_EMAIL && window.CONTACTS_BY_EMAIL[id];

  if (isContact) {
    const contact = window.CONTACTS_BY_EMAIL[id];
    // Use contact name if available (First letter of how he is recorded)
    if (contact.contact_name) {
      displayName = contact.contact_name;
    }
    // Consistent color for contacts ("color some kind on background")
    color = getAvatarColor(id);
  } else {
    // Not in contacts
    // Use provided name (which is usually username/nickname)
    // "random pleasant color" -> random from palette
    // We use getAvatarColor(id || displayName) to ensure consistency and avoid flickering on re-renders,
    // while still providing a "random" (arbitrary) pleasant color from the palette.
    color = getAvatarColor(id || displayName);
  }

  const initial = displayName.charAt(0).toUpperCase();
  
  // Create SVG string
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" fill="${color}" />
      <text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="${size * 0.5}px" font-weight="bold">${initial}</text>
    </svg>
  `;
  
  // Encode SVG to base64
  const base64 = btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Returns the appropriate display name for avatar generation.
 * Prioritizes: Contact Name > Username (Nickname) > Full Name > Email.
 * @param {object} user - User object.
 * @returns {string} Display name.
 */
export function getAvatarDisplayName(user) {
  // 1. If contact_name is explicitly provided, use it
  if (user.contact_name) return user.contact_name;

  // 2. Try to find in global contacts cache
  if (user.email && window.CONTACTS_BY_EMAIL && window.CONTACTS_BY_EMAIL[user.email]) {
    const contact = window.CONTACTS_BY_EMAIL[user.email];
    if (contact.contact_name) return contact.contact_name;
  }

  // 3. If not in contacts, prioritize Username (Nickname) as requested
  return user.username || user.display_name || user.full_name || user.email || "?";
}

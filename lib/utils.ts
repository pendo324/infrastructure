export const CODEBUILD_ARCHS: string[] = ['x86_64_ubuntu', 'arm64_ubuntu'];

// members of the runfinch org (+dependabot)
// curl -s https://api.github.com/users/<username> | jq '.id'
// TODO: automate fetching account ID's
export const GITHUB_ALLOWLISTED_ACCOUNT_IDS = [
    '47769978',     // coderbirju
    '424987',       // pendo324
    '55906459',     // austinvazquez
    '2304727',      // Kern--
    '2967759',      // henry118
    '47723536',     // Shubhranshu153
    '55555210',     // sondavidb
    '5525370',      // swagatbora90
    '59450965',     // cezar-r
    '49699333',     // dependabot[bot] github app
];

/**
 * Replaces all underscores with hyphens in a string.
 * Used for making strings compatible with stack names, which don't allow "_" in the name.
 * 
 * @param name The string to process
 * @returns A new string with all underscores replaced by hyphens
 */
export const toStackName = (name: string) => {
  return name.replace(/_/g, '-');
}
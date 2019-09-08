const s3 = require("./s3");
const { getEnv } = require("./helpers");

const isDir = fileinfo => fileinfo.longname.startsWith("d");

const pullFile = async fileContext => {
  const { sftp, dirpath, topPath, fileinfo } = fileContext;

  const filepath = `${dirpath}/${fileinfo.filename}`;
  console.log(`filepath= ${filepath}`);
  console.log(`dirpath = ${dirpath}`);
  console.log(`topPath = ${topPath}`);

  const fileData = await sftp.readFile(filepath);

  console.log(`file contents = ${fileData}`);

  // construct the target S3 key:
  // add custom prefix and delete initial top level directory
  const regexp = new RegExp(`^${topPath}`);
  const targetKey = `${getEnv("SFTP_TARGET_S3_PREFIX")}/${filepath.replace(
    regexp,
    ""
  )}`;

  const bucket = getEnv("SFTP_TARGET_S3_BUCKET");

  await s3.putObject({
    Bucket: bucket,
    Key: targetKey,
    Body: fileData
  });

  console.log(`moving ${filepath} to ${dirpath}/.done/`);
  await sftp.rename(filepath, `${dirpath}/.done/${fileinfo.filename}`);
  console.log(`moved`);
};

// decides whether to delete a single file based on age
const purgeOldFile = async ({
  sftp,
  dirpath,
  fileinfo,
  fileRetentionMilliseconds
}) => {
  console.log(`in .done: dirpath=${dirpath}, file=${fileinfo.filename}`);

  const currentDate = new Date();
  const fileAgeMilliseconds =
    currentDate - new Date(fileinfo.attrs.mtime * 1000); // mtime is seconds, Date() wants milliseconds
  if (fileAgeMilliseconds > fileRetentionMilliseconds) {
    const fileToDelete = `${dirpath}/.done/${fileinfo.filename}`;
    console.log(`delete ${fileToDelete}`);
    await sftp.unlink(fileToDelete);
  }
};

const dirListContainsDoneDir = dirList =>
  dirList.find(fileinfo => fileinfo.filename === ".done" && isDir(fileinfo));

const ensureDoneDirExists = async (sftp, dirList, dirpath) => {
  if (!dirListContainsDoneDir(dirList)) {
    await sftp.mkdir(`${dirpath}/.done/`);
  }
};

// purge any files in done dir which are old
const purgeDoneDir = async dirContext => {
  const { sftp, dirpath, fileRetentionMilliseconds } = dirContext;
  // only process the done dir if retention is enabled
  if (fileRetentionMilliseconds === 0) return;

  const dirList = await sftp.readdir(`${dirpath}/.done`);
  for (let i = 0; i < dirList.length; i += 1) {
    const fileinfo = dirList[i];

    await purgeOldFile({
      ...dirContext,
      fileinfo
    });
  }
};

const pullTreeRecursive = async dirContext => {
  const { sftp, dirpath, topPath } = dirContext;
  const dirList = await sftp.readdir(dirpath);

  console.log(`pullTreeRecursive(dirpath=${dirpath}, topPath=${topPath})`);
  await ensureDoneDirExists(sftp, dirList, dirpath);

  for (let i = 0; i < dirList.length; i += 1) {
    const fileinfo = dirList[i];
    const { filename } = fileinfo;

    if (isDir(fileinfo)) {
      if (filename === ".done") {
        await purgeDoneDir(dirContext);
      } else {
        await pullTreeRecursive({
          ...dirContext,
          dirpath: `${dirpath}/${filename}`
        });
      }
    } else {
      await pullFile({
        ...dirContext,
        fileinfo
      });
    }
  }
};

const pullTree = async dirContext => {
  // The top level starting directory will not change as we recurse.
  // This is so that we can construct a relative path in the target S3 bucket.
  const { dirpath } = dirContext;
  await pullTreeRecursive({ ...dirContext, topPath: dirpath });
};

module.exports = { pullTree };

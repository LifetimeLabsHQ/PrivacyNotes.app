// Keeps the app's data out of iCloud and computer backups of the phone, as
// Android does (`android:allowBackup="false"` and data_extraction_rules.xml).
// Two folders hold it: Library/WebKit, where the web view keeps IndexedDB and
// local storage (the sealed notes and the key material beside them), and the
// app group's ShareInbox, where the share extension leaves what it was given.
// Library/Caches and tmp are never backed up, so they need no mark.
//
// The mark is set when this class loads, before main, and again each time
// the app becomes active: WebKit creates its folder only when the web view
// first opens, so on a first launch the folder appears after the first pass.
// Neither folder is created here. The share extension creates ShareInbox
// with complete data protection and marks it too (ios-share/ShareViewController.swift).
// Spec: docs/internal/specs/share-into-app.md (section 3, Out of iPhone backups)
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

@interface PNBackupExclusion : NSObject
@end

@implementation PNBackupExclusion

+ (void)load {
  @autoreleasepool {
    [self markFolders];
    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
                                                    object:nil
                                                     queue:nil
                                                usingBlock:^(__unused NSNotification *note) {
                                                  [PNBackupExclusion markFolders];
                                                }];
  }
}

+ (void)markFolders {
  NSFileManager *fm = NSFileManager.defaultManager;
  NSMutableArray<NSURL *> *folders = [NSMutableArray array];
  NSURL *library = [fm URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask].firstObject;
  if (library) [folders addObject:[library URLByAppendingPathComponent:@"WebKit" isDirectory:YES]];
  NSURL *group = [fm containerURLForSecurityApplicationGroupIdentifier:@"group.app.privacynotes"];
  if (group) {
    [folders addObject:[group URLByAppendingPathComponent:@"ShareInbox" isDirectory:YES]];
    [folders addObject:[group URLByAppendingPathComponent:@"ShareMeta" isDirectory:YES]];
  }

  for (NSURL *folder in folders) {
    if (![fm fileExistsAtPath:folder.path]) continue;
    NSError *error = nil;
    if (![folder setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error]) {
      NSLog(@"backup exclusion failed for %@: %@", folder.lastPathComponent, error.localizedDescription);
    }
  }
}

@end

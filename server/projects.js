//
// Copyright (c) Autodesk, Inc. All rights reserved
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
//
// Forge Extractor
// by Cyrille Fauvel - Autodesk Developer Network (ADN)
//
var express =require ('express') ;
var bodyParser =require ('body-parser') ;
var fs =require ('fs') ;
var ForgeSDK =require ('forge-apis') ;
var config =require ('./config') ;
var utils =require ('./utils') ;
var forgeToken =require ('./forge-token') ;


var  CHUNK_SIZE  = 5;
var router =express.Router () ;
router.use (bodyParser.json ()) ; 


var uploadToOSS =function (identifier) {
	var bucket =config.bucket ;
	return (utils.json (identifier)
		.then (function (json) {
			var stream =fs.createReadStream (utils.path ('tmp/' + json.name))
				.on ('data', function (chunk) {
					json.bytesPosted +=chunk.length ;
					fs.writeFile (utils.data (identifier), JSON.stringify (json)) ;
				}) ;
			
			// direct upload for small size file
			//var ObjectsApi =new ForgeSDK.ObjectsApi () ;
			//return (ObjectsApi.uploadObject (bucket, json.name, json.bytesRead, stream, {}, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
			
			// resumable upload for large size file
			return resumableUploadFile(bucket,utils.path ('tmp/' + json.name),json.name);
		})
		.then (function (response) {

			//random sequence of the resolved body. Check which one is the last chunk , status code is 200
			// get out the body.
			var index = -1;
			
			for(i in response)
			{
			    if(response[i].statusCode == 200){
				index = i;
				break;
			    }
			}
			if(index > -1)
			{
				response[index].body.key =identifier ;
				return (utils.writeFile (utils.data (identifier), response[index].body)) ;
			}
			else{
				// return  fail?
			}
		})
	) ;
} ;


// random string for session id
function randomString(length, chars) {
    var result = '';
    for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

//upload by chunk

var resumableUploadFile = function(bucketKey, filePathName, fileName){
    console.log("**** Resumable Uploading file. bucket:"+ bucketKey + " filePath:"+filePathName);
    return new Promise(function(resolve, reject) {

         fs.stat(filePathName, function (err, stats) {

                if (err) {
                    reject(err);
                    return;
                }

                var fileSize = stats.size ;
                 var chunkSize = CHUNK_SIZE * 1024 * 1024 ;
                 var nbChunks = Math.round (0.5 + fileSize / chunkSize) ;
                 var rString = randomString(32,     '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');

                 var sessionID = 'forge-xiaodong-test-' + rString;

                  function unitPromise(n, chunkSize) {

                     return new Promise(function(resolve, reject){
                            var start = index * chunkSize;
                        var end = Math.min(fileSize, (index + 1) * chunkSize) - 1;
                        var contentRange = 'bytes ' + start + '-' + end + '/' + fileSize;
                        var length = end - start + 1;
                            console.log("**** chunk upload:"+ start + 
                            " end:"+end );


			var readStream = fs.createReadStream(filePathName, { start: start, end: end });
			var ObjectsApi =new ForgeSDK.ObjectsApi () ;
                        ObjectsApi.uploadChunk(bucketKey, 
                                            fileName, 
                                            length, 
                                            contentRange,
                                             sessionID, 
                                             readStream, {}, 
                                             forgeToken.TwoLegged, 
                                             forgeToken.TwoLegged.getCredentials())
                        .then(
                            function(res){
                                if(res.statusCode == 202)
                                {
                                    console.log("*********one chunk upload succeeded!");
                                    //continue the next chunk
                                    resolve(res);

                                }
                                else if(res.statusCode == 200)
                                {
                                    //last chunk
                                    console.log("********last chunk upload succeeded!");
                                    resolve(res);
                                }
                            },function(err){
                                console.log("*********one chunk upload failed!"+err.statusCode);

                                reject(err);
                            }
                        );
                     });
                  }//unit promise function

                var uploadpromises = [];

                for( var index=0;index<nbChunks;index++)
                 {
                    uploadpromises.push(unitPromise(index,chunkSize));
                 }

                 Promise.all(uploadpromises)    
                     .then(function(data){resolve(data); })
                     .catch(function(err){ reject(err);}); 
         });
    });
  
};

// Post files to OSS and request translation
router.post ('/projects', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (500). end ()) ;

	var bucket =config.bucket ;
	var regex =new RegExp ('^[-_.a-z0-9]{3,128}$') ;
	if (!regex.test (bucket))
		return (res.status (403).send ('Bucket name invalid!')) ;

	utils.writeFile (utils.data (req.body.uniqueIdentifier + '.job'), req.body.children) ;
	var uploadPromises =req.body.children.map (uploadToOSS) ;
	Promise.all (uploadPromises)
		.then (function (files) {
			//console.log (JSON.stringify (files, null, 2)) ;
			for ( var i =0 ; i < files.length ; i++ ) {
				console.log (files [i].objectKey + ' uploaded to OSS') ;
				utils.unlink (utils.path ('tmp/' + files [i].objectKey)) ;
			}
			return (utils.json (req.body.uniqueIdentifier)) ;
		})
		.then (function (mainFile) {
			var urn =utils.safeBase64encode (mainFile.objectId) ;
			var job ={
				'input': {
					'urn': urn,
				},
				'output': {
					'formats': [
						{ 'type': "svf", 'views': [ '2d', '3d' ] },
					]
				}
			} ;
			if ( utils.isCompressed (mainFile.objectKey) ) {
				job.input.compressedUrn =true ;
				job.input.rootFilename =req.body.main ;
			}
			var ModelDerivative =new ForgeSDK.DerivativesApi () ;
			return (ModelDerivative.translate (job, { xAdsForce: true }, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
		})
		.then (function (response) {
			console.log (response.body.urn + ' translation requested') ;
			var data ={
				urn: response.body.urn,
				progress: '0% complete',
				status: 'requested',
				progress: '0%',
				name: utils.safeBase64decode (response.body.urn).replace (/^.*\//, ''),
				key: req.body.uniqueIdentifier
			} ;
			utils.writeFile (utils.data (req.body.uniqueIdentifier + '.resultdb'), data) ;

			// Ok, now we rely on the client browser to pull the manifest and thumbnail, but what if the user
			// close his browser before the translation complete - pull the manifest when another user comes
			// online via the GET /api/results endpoint & the thumbnail whne we display the vignettes via the
			// GET /api/results/:identifier/thumbnail endpoint
		})
		.catch (function (error) {
			console.error (error) ;
		}) ;

	// We submitted uploads and translation,
	// no clue at this stage if they were successful or not
	res
		.json (req.body) ;
}) ;

// Get the uploading/translation progress
var uploadedBytes =function (identifier) {
	return (utils.json (identifier)
		.then (function (json) {
			if ( json.hasOwnProperty ('bytesPosted') )
				return ({ bytesRead: json.bytesRead, bytesPosted: json.bytesPosted }) ;
			else
				return ({ bytesRead: json.size, bytesPosted: json.size }) ;
		})
	) ;
} ;

var uploadProgress =function (req, res) {
	var identifier =req.params.identifier ;
	utils.json (identifier +'.job')
		.then (function (list) {
			var uploadPromises =list.map (uploadedBytes) ;
			return (Promise.all (uploadPromises)) ;
		})
		.then (function (results) {
			var bytesRead = 0, bytesPosted =0 ;
			for ( var i =0 ; i < results.length ; i++ ) {
				bytesRead += results [i].bytesRead ;
				bytesPosted += results [i].bytesPosted ;
			}
			res.json ({
				//bytesRead: bytesRead,
				//bytesPosted: bytesPosted,
				status: 'requested',
				progress: 'uploading to oss',
				oss: (Math.floor (100 * bytesPosted / bytesRead) + '%'),
			}) ;
		})
		.catch (function (error) {
			res.status (404).end ('No information found!') ;
		})
	;
} ;

router.get ('/projects/:identifier/progress', function (req, res) {
	// Protect the endpoint from external usage.
	if ( !utils.checkHost (req, config.domain) )
		return (res.status (500). end ()) ;

	var bucket =config.bucket ;
	var identifier =req.params.identifier ;

	// At this stage, we are supposed to have provisioned a .resultdb file, but it does not mean
	// we finished uploading all files, so the file might be missing
	utils.json (identifier)
		.then (function (data) {
			//if ( !data.hasOwnProperty ('urn') )
			//	throw new Error ('No URN') ;
			var urn =utils.safeBase64encode (data.objectId) ;
			var ModelDerivative =new ForgeSDK.DerivativesApi () ;
			return (ModelDerivative.getManifest (urn, {}, forgeToken.RW, forgeToken.RW.getCredentials ())) ;
		})
		.then (function (manifest) {
			//console.log(JSON.stringify(manifest, null, 2)) ;
			manifest.body.name =utils.safeBase64decode (manifest.body.urn).replace (/^.*\//, '') ;
			manifest.body.key =identifier ;
			utils.writeFile (utils.data (identifier + '.resultdb'), manifest.body) ;
			res.json ({
				status: manifest.body.status,
				progress: manifest.body.progress,
				hasThumbnail: manifest.body.hasThumbnail,
			}) ;
		})
		.catch (function (error) {
			// No .resultdb file, we are still uploading files
			uploadProgress (req, res) ;
		})
	;
}) ;

module.exports =router ;

import React, { useState, useCallback, useEffect } from 'react';
import { Search, Folder, AlertCircle, Sun, Moon, Download, Wand2, SlidersHorizontal } from 'lucide-react';
import * as PDFJS from 'pdfjs-dist';
import mammoth from 'mammoth';

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

let isWorkerInitialized = false;

interface SearchResult {
  fileName: string;
  filePath: string;
  fileType: string;
  status: 'success' | 'error' | 'unsupported';
  error?: string;
  matches: Array<{
    text: string;
    lineNumber: number;
    context: string;
    occurrences: number;
  }>;
  matchCount: number;
  totalOccurrences: number;
  rawText?: string;
}

interface SearchOptions {
  matchType: 'all' | 'any';
  caseSensitive: boolean;
  wholeWord: boolean;
}

function App() {
  const [searchTerms, setSearchTerms] = useState<string[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(() => 
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  const [processedFiles, setProcessedFiles] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({
    matchType: 'all',
    caseSensitive: false,
    wholeWord: false,
  });
  const [showSearchOptions, setShowSearchOptions] = useState(false);

  useEffect(() => {
    if (!isWorkerInitialized) {
      const workerUrl = new URL(
        'pdfjs-dist/build/pdf.worker.min.js',
        import.meta.url
      );
      PDFJS.GlobalWorkerOptions.workerSrc = workerUrl.href;
      isWorkerInitialized = true;
    }
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const extractTextFromPDF = async (file: File): Promise<string> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = PDFJS.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      let fullText = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        
        // Get regular text content
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(' ');
        
        // Get annotations (including form fields)
        const annotations = await page.getAnnotations();
        const annotationText = annotations
          .filter(annotation => 
            annotation.fieldType === 'Tx' || // Text fields
            annotation.fieldType === 'Ch' || // Choice fields (dropdown/list)
            annotation.fieldValue !== undefined
          )
          .map(annotation => annotation.fieldValue)
          .filter(Boolean)
          .join(' ');
        
        fullText += `Page ${i}:\n${pageText}\n${annotationText}\n\n`;
      }
      
      return fullText;
    } catch (err) {
      console.error('Error extracting PDF text:', err);
      throw new Error('Failed to extract text from PDF');
    }
  };

  const extractTextFromWord = async (file: File): Promise<string> => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    } catch (err) {
      console.error('Error extracting Word text:', err);
      throw new Error('Failed to extract text from Word document');
    }
  };

  const findMatches = (text: string): Array<{ text: string; lineNumber: number; context: string; occurrences: number }> => {
    const matches: Array<{ text: string; lineNumber: number; context: string; occurrences: number }> = [];
    const lines = text.split('\n');
    
    if (searchTerms.length === 0) return matches;

    lines.forEach((line, index) => {
      const lineToSearch = searchOptions.caseSensitive ? line : line.toLowerCase();
      let isMatch = false;
      let occurrences = 0;

      const termMatches = searchTerms.map(term => {
        const termToFind = searchOptions.caseSensitive ? term : term.toLowerCase();
        const regex = new RegExp(
          searchOptions.wholeWord ? `\\b${termToFind}\\b` : termToFind,
          searchOptions.caseSensitive ? 'g' : 'gi'
        );
        return lineToSearch.match(regex)?.length || 0;
      });

      if (searchOptions.matchType === 'all') {
        isMatch = termMatches.every(count => count > 0);
      } else {
        isMatch = termMatches.some(count => count > 0);
      }

      if (isMatch) {
        occurrences = termMatches.reduce((sum, count) => sum + count, 0);
        const contextStart = Math.max(0, index - 2);
        const contextEnd = Math.min(lines.length, index + 3);
        const context = lines.slice(contextStart, contextEnd).join('\n');
        
        // Highlight matches in context
        let highlightedContext = context;
        searchTerms.forEach(term => {
          const termToFind = searchOptions.caseSensitive ? term : term;
          const regex = new RegExp(
            searchOptions.wholeWord ? `\\b(${termToFind})\\b` : `(${termToFind})`,
            searchOptions.caseSensitive ? 'g' : 'gi'
          );
          highlightedContext = highlightedContext.replace(regex, '**$1**');
        });

        matches.push({
          text: line.trim(),
          lineNumber: index + 1,
          context: highlightedContext.trim(),
          occurrences
        });
      }
    });
    
    return matches;
  };

  const handleSearchInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && currentInput.trim()) {
      e.preventDefault();
      setSearchTerms(prev => [...prev, currentInput.trim()]);
      setCurrentInput('');
    } else if (e.key === 'Backspace' && !currentInput && searchTerms.length > 0) {
      setSearchTerms(prev => prev.slice(0, -1));
    }
  };

  const removeSearchTerm = (indexToRemove: number) => {
    setSearchTerms(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const handleFolderSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || searchTerms.length === 0) return;

    setIsSearching(true);
    setError(null);
    setResults([]);
    setProcessedFiles(0);
    setTotalFiles(files.length);
    
    const searchResults: SearchResult[] = [];

    try {
      for (const file of Array.from(files)) {
        let result: SearchResult = {
          fileName: file.name,
          filePath: file.webkitRelativePath || file.name,
          fileType: file.type || 'unknown',
          status: 'success',
          matches: [],
          matchCount: 0,
          totalOccurrences: 0
        };

        try {
          let text = '';
          
          if (file.type === 'application/pdf') {
            text = await extractTextFromPDF(file);
          } else if (
            file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.type === 'application/msword'
          ) {
            text = await extractTextFromWord(file);
          } else if (file.type.includes('text') || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
            text = await file.text();
          } else {
            result.status = 'unsupported';
            result.error = 'Unsupported file type';
            searchResults.push(result);
            setProcessedFiles(prev => prev + 1);
            continue;
          }

          result.rawText = text;
          const matches = findMatches(text);
          result.matches = matches;
          result.matchCount = matches.length;
          result.totalOccurrences = matches.reduce((sum, match) => sum + match.occurrences, 0);
          
        } catch (err) {
          result.status = 'error';
          result.error = err instanceof Error ? err.message : 'Unknown error';
        }

        searchResults.push(result);
        setProcessedFiles(prev => prev + 1);
        // Update results in real-time
        setResults(prev => [...prev, result].sort((a, b) => b.matchCount - a.matchCount));
      }
      
      if (searchResults.every(r => r.matchCount === 0)) {
        setError('No matches found in any of the selected files.');
      }
    } catch (err) {
      setError('An error occurred while searching the files.');
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  }, [searchTerms, searchOptions]);

  const downloadCSV = useCallback(() => {
    // Only include documents that have matches
    const matchingResults = results.filter(result => result.matchCount > 0);
    
    const headers = [
      'File Name',
      'File Path',
      'File Type',
      'Total Matches',
      'Total Occurrences',
      'Matching Lines'
    ];
    
    const rows = matchingResults.map(result => [
      result.fileName,
      result.filePath,
      result.fileType,
      result.matchCount,
      result.totalOccurrences,
      result.matches
        .map(m => `Line ${m.lineNumber} (${m.occurrences} occurrences)`)
        .join('; ')
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `search-results-${searchTerms.join('-')}.csv`;
    link.click();
  }, [results, searchTerms]);

  return (
    <div className={`min-h-screen transition-colors duration-200 ${
      isDarkMode ? 'bg-gray-900' : 'bg-gradient-to-br from-gray-50 to-gray-100'
    }`}>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex justify-between items-center mb-8">
          <div className="text-center flex-1">
            <h1 className={`text-4xl font-bold mb-2 flex items-center justify-center gap-3 ${
              isDarkMode ? 'text-white' : 'text-gray-800'
            }`}>
              <Wand2 className={`${
                isDarkMode ? 'text-purple-400' : 'text-purple-600'
              }`} size={32} />
              TaDa Search
            </h1>
            <p className={`${
              isDarkMode ? 'text-gray-300' : 'text-gray-600'
            }`}>Search through your documents quickly and efficiently</p>
          </div>
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-2 rounded-full ${
              isDarkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-200 text-gray-700'
            } hover:opacity-80 transition-opacity`}
          >
            {isDarkMode ? <Sun size={24} /> : <Moon size={24} />}
          </button>
        </div>

        <div className={`rounded-xl shadow-lg p-6 mb-6 ${
          isDarkMode ? 'bg-gray-800' : 'bg-white'
        }`}>
          <div className="flex flex-col gap-4">
            <div className="relative">
              <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${
                isDarkMode ? 'text-gray-400' : 'text-gray-400'
              }`} size={20} />
              <div className={`flex flex-wrap items-center gap-2 w-full pl-10 pr-12 py-2 rounded-lg border transition-all ${
                isDarkMode 
                  ? 'bg-gray-700 border-gray-600 text-white'
                  : 'border-gray-200'
              }`}>
                {searchTerms.map((term, index) => (
                  <span
                    key={index}
                    className={`flex items-center gap-1 px-2 py-1 rounded-full text-sm ${
                      isDarkMode
                        ? 'bg-gray-600 text-gray-200'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {term}
                    <button
                      onClick={() => removeSearchTerm(index)}
                      className="hover:text-red-500 focus:outline-none"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  placeholder={searchTerms.length === 0 ? "Enter search terms..." : "Add another term..."}
                  className={`flex-1 min-w-[150px] bg-transparent border-none focus:outline-none ${
                    isDarkMode 
                      ? 'placeholder-gray-400'
                      : 'placeholder-gray-500'
                  }`}
                  value={currentInput}
                  onChange={(e) => setCurrentInput(e.target.value)}
                  onKeyDown={handleSearchInput}
                />
              </div>
              <button
                onClick={() => setShowSearchOptions(!showSearchOptions)}
                className={`absolute right-3 top-1/2 transform -translate-y-1/2 p-1 rounded-md ${
                  isDarkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-100'
                }`}
                title="Search options"
              >
                <SlidersHorizontal size={20} className={
                  isDarkMode ? 'text-gray-400' : 'text-gray-500'
                } />
              </button>
            </div>

            {showSearchOptions && (
              <div className={`p-4 rounded-lg ${
                isDarkMode ? 'bg-gray-700' : 'bg-gray-50'
              }`}>
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <label className={`flex items-center gap-2 ${
                      isDarkMode ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      <input
                        type="radio"
                        name="matchType"
                        checked={searchOptions.matchType === 'all'}
                        onChange={() => setSearchOptions(prev => ({ ...prev, matchType: 'all' }))}
                        className="text-blue-500 focus:ring-blue-500"
                      />
                      Match all terms
                    </label>
                    <label className={`flex items-center gap-2 ${
                      isDarkMode ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      <input
                        type="radio"
                        name="matchType"
                        checked={searchOptions.matchType === 'any'}
                        onChange={() => setSearchOptions(prev => ({ ...prev, matchType: 'any' }))}
                        className="text-blue-500 focus:ring-blue-500"
                      />
                      Match any term
                    </label>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <label className={`flex items-center gap-2 ${
                      isDarkMode ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      <input
                        type="checkbox"
                        checked={searchOptions.caseSensitive}
                        onChange={(e) => setSearchOptions(prev => ({ ...prev, caseSensitive: e.target.checked }))}
                        className="text-blue-500 focus:ring-blue-500"
                      />
                      Case sensitive
                    </label>
                    <label className={`flex items-center gap-2 ${
                      isDarkMode ? 'text-gray-300' : 'text-gray-700'
                    }`}>
                      <input
                        type="checkbox"
                        checked={searchOptions.wholeWord}
                        onChange={(e) => setSearchOptions(prev => ({ ...prev, wholeWord: e.target.checked }))}
                        className="text-blue-500 focus:ring-blue-500"
                      />
                      Match whole words only
                    </label>
                  </div>
                </div>
              </div>
            )}
            
            <div className="relative">
              <label
                htmlFor="folder-upload"
                className={`flex items-center justify-center gap-2 w-full py-3 px-4 border-2 border-dashed rounded-lg cursor-pointer transition-all ${
                  isDarkMode
                    ? 'border-gray-600 hover:border-blue-500 hover:bg-gray-700'
                    : 'border-gray-300 hover:border-blue-500 hover:bg-blue-50'
                }`}
              >
                <Folder className={isDarkMode ? 'text-gray-300' : 'text-gray-500'} size={20} />
                <span className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                  Select folder to search
                </span>
                <input
                  id="folder-upload"
                  type="file"
                  webkitdirectory="true"
                  directory="true"
                  multiple
                  className="hidden"
                  onChange={handleFolderSelect}
                  disabled={!searchTerms.length}
                />
              </label>
              <p className={`mt-2 text-sm text-center ${
                isDarkMode ? 'text-gray-400' : 'text-gray-500'
              }`}>
                Supported formats: PDF, Word (DOC/DOCX), and text files
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className={`flex items-center gap-2 p-4 rounded-lg mb-6 ${
            isDarkMode ? 'bg-red-900/50 text-red-300' : 'bg-red-50 text-red-700'
          }`}>
            <AlertCircle size={20} />
            <p>{error}</p>
          </div>
        )}

        {isSearching && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                Processing files: {processedFiles} / {totalFiles}
              </span>
              <span className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                {Math.round((processedFiles / totalFiles) * 100)}%
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
              <div 
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                style={{ width: `${(processedFiles / totalFiles) * 100}%` }}
              ></div>
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className={`text-xl font-semibold ${
                isDarkMode ? 'text-white' : 'text-gray-800'
              }`}>
                Search Results ({results.length} files)
              </h2>
              <button
                onClick={downloadCSV}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
                  isDarkMode 
                    ? 'bg-blue-600 hover:bg-blue-700' 
                    : 'bg-blue-500 hover:bg-blue-600'
                } text-white transition-colors`}
              >
                <Download size={18} />
                Export CSV
              </button>
            </div>
            <div className="space-y-4">
              {results.map((result, index) => (
                <div key={index} className={`rounded-lg shadow p-4 hover:shadow-md transition-shadow ${
                  isDarkMode ? 'bg-gray-800' : 'bg-white'
                }`}>
                  <div className="flex items-start gap-3">
                    <Folder className={`flex-shrink-0 ${
                      result.status === 'success' 
                        ? 'text-blue-500' 
                        : result.status === 'error' 
                          ? 'text-red-500' 
                          : 'text-gray-500'
                    }`} size={24} />
                    <div className="flex-1">
                      <div className="flex justify-between items-start">
                        <h3 className={`font-semibold mb-1 ${
                          isDarkMode ? 'text-white' : 'text-gray-800'
                        }`}>{result.fileName}</h3>
                        <span className={`text-sm px-2 py-1 rounded ${
                          result.status === 'success' 
                            ? isDarkMode ? 'bg-green-900/50 text-green-300' : 'bg-green-100 text-green-800'
                            : result.status === 'error'
                              ? isDarkMode ? 'bg-red-900/50 text-red-300' : 'bg-red-100 text-red-800'
                              : isDarkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-800'
                        }`}>
                          {result.status}
                        </span>
                      </div>
                      <p className={`text-sm mb-2 ${
                        isDarkMode ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        Path: {result.filePath}
                      </p>
                      {result.error ? (
                        <p className={`text-sm ${
                          isDarkMode ? 'text-red-300' : 'text-red-600'
                        }`}>{result.error}</p>
                      ) : (
                        <>
                          <p className={`text-sm mb-2 ${
                            isDarkMode ? 'text-gray-400' : 'text-gray-500'
                          }`}>
                            Found {result.matchCount} matches
                          </p>
                          <div className="space-y-2">
                            {result.matches.map((match, idx) => (
                              <div key={idx} className={`text-sm p-3 rounded ${
                                isDarkMode ? 'bg-gray-700' : 'bg-gray-50'
                              }`}>
                                <div className="mb-1 font-medium flex justify-between">
                                  <span>Match {idx + 1} (Line {match.lineNumber})</span>
                                  <span className="text-blue-500">{match.occurrences} occurrence{match.occurrences !== 1 ? 's' : ''}</span>
                                </div>
                                <div className="whitespace-pre-wrap prose prose-sm max-w-none dark:prose-invert">
                                  {match.context.split('**').map((part, i) => 
                                    i % 2 === 0 ? (
                                      part
                                    ) : (
                                      <mark key={i} className={`bg-yellow-200 dark:bg-yellow-900 dark:text-yellow-200 px-0.5 rounded`}>
                                        {part}
                                      </mark>
                                    )
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
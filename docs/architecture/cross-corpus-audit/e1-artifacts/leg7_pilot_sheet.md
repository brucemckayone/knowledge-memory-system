# Leg 7 — F.2 blind labelling sheet (pilot, n=30)

**Rule F.2:** a function should perform *a single logical operation*.

Mark **VIOLATION** if the function does more than one logical operation / has more than one responsibility / mixes abstraction levels / can't be named without "and". Mark **OK** if it does one coherent thing (a chain of helper calls at one level of abstraction is still "one thing"). Mark **SKIP** if it isn't really a function or you genuinely can't judge it.

Fill in `Verdict:` (VIOLATION / OK / SKIP) and `Conf:` (H/M/L) for each. Do this **before** looking at any tool output. Optional one-line `Note:`.

---

### 1. `lib_common/src/ApiLogging/Serialization/TimeDataSerializer.cpp:43` — serialize  _(5 lines)_

```cpp
void serialize(BufferWriter& writer, TimeData<ExpectedPeriodData> const& timeData)
{
   TimeSerializer::serialize(writer, timeData.time);
   ExpectedPeriodDataSerializer::serialize(writer, timeData.data);
}
```

- Verdict: OK
- Conf: H
- Note: serializs time single component responsaibility

### 2. `alpha_conversion/src/Managers/ConversionManager.cpp:567` — xmlToFile  _(4 lines)_

```cpp
void ConversionManager::xmlToFile(const std::string& xml)
{
   m_hlfToTextSerializer->xmlToFile(xml);
}
```

- Verdict: OK
- Conf: H
- Note: 

### 3. `lib_positioning_engine/src/Core/Models/TropoGpt2.cpp:685` — getWetMappingFunction  _(9 lines)_

```cpp
double getWetMappingFunction(
   const GeodeticCoordinates& coords,
   const Time& time,
   const double elevation) // Elevation (rad)
{
   HydrostaticWetPair mappings;
   getMappingFunction(coords, time, elevation, mappings);
   return mappings.wet;
}
```

- Verdict: OK
- Conf: simple getter 
- Note: 

### 4. `lib_positioning_engine/src/Core/States/StateKeySet.hpp:43` — StateKeySet  _(8 lines)_

```cpp
/// @brief Constructs an empty StateKeySet and reserves space for the maximum number of elements.
   StateKeySet()
      : m_keySet(std::pmr::get_default_resource())
      , m_indexMap(std::pmr::get_default_resource())
   {
      m_keySet.reserve(MAX_NUMBER_OF_STATES);
      m_indexMap.reserve(MAX_NUMBER_OF_STATES);
   }
```

- Verdict: OK
- Conf: G
- Note: 

### 5. `test/alpha_replayer/Io/MockTcpClient.cpp:28` — disconnect  _(5 lines)_

```cpp
void MockTcpClient::disconnect()
{
   std::lock_guard<std::mutex> lock(m_mutex);
   m_connected = false;
}
```

- Verdict: OK
- Conf: H
- Note: 

### 6. `alpha_replayer/src/Managers/EngineManager.cpp:54` — getEngine  _(10 lines)_

```cpp
EngineFactory::EngineVariant& EngineManager::getEngine(uint16_t streamId)
{
   if (const auto iter = m_engineStreamMap.find(streamId); iter != m_engineStreamMap.end())
   {
      return iter->second;
   }

   throw InvalidArgumentException(
      "Engine manager cannot find engine associated with stream_id: " + std::to_string(streamId));
}
```

- Verdict: OK
- Conf: M
- Note: 

### 7. `lib_positioning_engine/src/Core/Models/GeometryUtilities.cpp:102` — computeElevationAngle  _(13 lines)_

```cpp
double computeElevationAngle(const Vector<DIMENSION_3D>& rxPos, const Vector<DIMENSION_3D>& satPos)
{
   // TODO: If this function is computationally expensive, consider caching the computed angle
   // and recomputing only when necessary.
   const GeodeticCoordinates geodetic
      = transformWgs84(CartesianCoordinates{rxPos(0), rxPos(1), rxPos(2)});
   const Matrix<DIMENSION_3D, DIMENSION_3D> ecefToLLRotationMatrix
      = computeEcefToLLRotationMatrix(geodetic);
   const Vector<DIMENSION_3D> localLevelReceiverToSatelliteVector
      = ecefToLLRotationMatrix * (satPos - rxPos);
   const double hzDist = localLevelReceiverToSatelliteVector.head(2).norm();
   return std::atan2(localLevelReceiverToSatelliteVector(2), hzDist);
}
```

- Verdict: violation
- Conf: L
- Note: both gets data and calculates it

### 8. `test/lib_positioning_engine/Logger/LoggerTests.cpp:423` — injectData  _(7 lines)_

```cpp
void injectData(int data)
   {
      mFrontThread.pushEvent(data);
      mBackThread.pushEvent(data);
      mApiThread.pushEvent(data);
      Logger::info(FacilityCode::Initialization, "injectData");
   }
```

- Verdict: VIOLATION
- Conf: H 
- Note: also Logs side effect

### 9. `test/alpha_replayer/Io/MockTcpClient.cpp:127` — setSocketAddress  _(4 lines)_

```cpp
void MockTcpClient::setSocketAddress(const std::string& address)
{
   m_socketAddress = address;
}
```

- Verdict: OK
- Conf: H
- Note: 

### 10. `lib_positioning_engine/src/Core/Estimators/FloatEstimator.hpp:248` — doCoarsePositioning  _(57 lines)_

```cpp
FilterStatusCode doCoarsePositioning(
      const GnssMeasurements& gnssMeasurements,
      const SatellitePositions& satellitePositions)
   {
      // Check the time stamp of the state.
      if (!compareEqual(m_filter.template getState<FilterState>().getTime(), Time()))
      {
         // State time is valid, no need for coarse positioning.
         return FilterStatusCode::Success;
      }

      LOG_DEBUG(FacilityCode::Estimator, "{},CoarsePos,Started", gnssMeasurements.time);
      // Generate update measurements
      const UpdateMeasurements updateMeasurements
         = Policies::createCoarseUpdateMeasurements(gnssMeasurements, satellitePositions);

      // Prepare the state for the measurement update by augmenting it with any states required by
      // the coarse positioning measurements and models, and setting the time to that of the GNSS
      // measurements.
      FilterState copyOfFilterState = m_filter.template getState<FilterState>();
      copyOfFilterState.setTime(gnssMeasurements.time);
      Policies::augmentState(updateMeasurements, copyOfFilterState);
      m_filter.reinitialize(copyOfFilterState);

      const FilterStatusCode coarsePosStatus = m_filter.update(updateMeasurements);

      // Check the status of the coarse positioning.
      if (coarsePosStatus == FilterStatusCode::Success)
      {
         State coarseState(m_filter.template getState<FilterState>());

         StochasticState<Coordinates> coarsePos = StochasticState<Coordinates>{};
         coarseState.getFullState(coarsePos);
         LOG_TRACE(FacilityCode::Estimator, "{},CoarsePos,{}", gnssMeasurements.time, coarsePos);
         logStatePerType(coarseState);

         coarseState.template eraseStateType<PseudorangeSignalBias>();
         coarseState.getModifiableLinearizationPoint() += coarseState.getVector();
         coarseState.getModifiableVector().setZero();
         coarseState.getModifiableMatrix().diagonal().array()
            += SpectralDensityScalar<OPERATING_MODE, Coordinates>::VALUE;

         m_filter.reinitialize(FilterState(coarseState));

         LOG_DEBUG(
            FacilityCode::Estimator,
            "{},FilterStateReInitialized with coarse position",
            gnssMeasurements.time);
         logStatePerType(coarseState);
      }
      else
      {
         m_filter.reset();
      }

      return coarsePosStatus;
   }
```

- Verdict: VIOLATION
- Conf: H
- Note: 

### 11. `lib_positioning_engine/src/Core/States/State.hpp:47` — State  _(8 lines)_

```cpp
/// @brief Default constructor initializes the state vector, matrix, linearization point
   /// and the state key sets to empty.
   ///
   State()
      : m_time()
      , m_matrix()
      , m_keySets()
   {}
```

- Verdict: OK
- Conf: H
- Note: constructor default 

### 12. `alpha_conversion/src/Serialization/Xml/ApiData/Deserializers/ApiInvocationXmlDeserializer.cpp:393` — createSetCorrectionsExpectedPeriodInvocation  _(30 lines)_

```cpp
std::shared_ptr<SetCorrectionsExpectedPeriodInvocation>
ApiInvocationXmlDeserializer::createSetCorrectionsExpectedPeriodInvocation(
   mxml_node_t* const apiInvocationNode,
   uint16_t streamId,
   ErrorCode errorCode)
{
   std::shared_ptr<SetCorrectionsExpectedPeriodInvocation> setExpectedPeriodInvocation = nullptr;

   if (
      mxml_node_t* const expectedPeriodNode
      = getElementNodeFromPath(apiInvocationNode, PATH_EXPECTED_PERIOD))
   {
      ExpectedPeriod expectedPeriod;

      SourceAndTimeDataXmlDeserializer::deserialize(expectedPeriodNode, expectedPeriod);

      setExpectedPeriodInvocation = std::make_shared<SetCorrectionsExpectedPeriodInvocation>(
         streamId,
         errorCode,
         expectedPeriod);
   }
   else
   {
      throw XmlSerializationException(
         "ApiInvocationXmlDeserializer: Could not find Element: "
         + std::string(PATH_EXPECTED_PERIOD));
   }

   return setExpectedPeriodInvocation;
}
```

- Verdict: OK
- Conf: M
- Note:  Gets and creates from data 

### 13. `alpha_replayer/src/Logging/EngineErrorLogger.cpp:29` — enable  _(10 lines)_

```cpp
void EngineErrorLogger::enable(const std::filesystem::path& filePath)
{
   m_fileWriter->open(filePath);

   registerLoggerCallback([this](const uint8_t level, const char* const data, const size_t size) {
      log(level, data, size);
   });

   m_enabled.store(true);
}
```

- Verdict: VIOLATION
- Conf: M
- Note: encapuslates a number of logical operations all bussineslogic orchestration

### 14. `lib_positioning_engine/src/Core/Synchronizer/RequirementBasedStrategy.hpp:210` — computeNextPackageImpl  _(6 lines)_

```cpp
/// @copydoc IStrategy::computeNextPackage
   Output computeNextPackageImpl()
   {
      // Get the next package from the assembler.
      return m_assembler.nextPackage();
   }
```

- Verdict: OK
- Conf: H
- Note: 

### 15. `lib_positioning_engine/src/Core/Utility/ModelUtility.hpp:37` — getModifiedJulianDate  _(9 lines)_

```cpp
/// @brief Calculates the Modified Julian Date (MJD) for the given time.
/// @param time The GPS time.
/// @return The Modified Julian Date.
inline double getModifiedJulianDate(const Time& time)
{
   const auto daysFromWeeks = static_cast<double>(time.weeks * DAYS_PER_WEEK);
   const double daysFromSeconds = time.seconds.value / SECONDS_PER_DAY;
   return MJD_GPS_EPOCH + daysFromWeeks + daysFromSeconds;
}
```

- Verdict: OK
- Conf: M
- Note: bad naming really

### 16. `alpha_conversion/src/Managers/FileManager.cpp:170` — fileSize  _(4 lines)_

```cpp
std::size_t FileManager::fileSize() const
{
   return m_fileSize;
}
```

- Verdict: OK
- Conf: H
- Note: 

### 17. `alpha_conversion/src/Managers/FileManager.cpp:150` — safeClose  _(14 lines)_

```cpp
void FileManager::safeClose()
{
   if (m_stream.is_open())
   {
      m_stream.close();
   }

   if (m_outputStream.is_open())
   {
      m_outputStream.close();
   }

   m_fileSize = 0;
}
```

- Verdict: VIOLATION
- Conf: L
- Note: canClose and CLose encapsulated and reset state 

### 18. `lib_common/src/ApiLogging/ApiData/SetCorrectionsExpectedPeriodInvocation.cpp:19` — SetCorrectionsExpectedPeriodInvocation  _(7 lines)_

```cpp
SetCorrectionsExpectedPeriodInvocation::SetCorrectionsExpectedPeriodInvocation(
   const uint16_t streamId,
   const ErrorCode errorCode,
   const ExpectedPeriod& expectedPeriod)
   : ApiInvocation(Api::SetCorrectionsExpectedPeriod, streamId, errorCode)
   , m_expectedPeriod(expectedPeriod)
{}
```

- Verdict: OK
- Conf: H
- Note: standard constructor

### 19. `lib_common/src/ApiLogging/ApiData/SolutionOutput.cpp:17` — SolutionOutput  _(3 lines)_

```cpp
SolutionOutput::SolutionOutput()
   : ApiOutput(OutputDataType::SolutionOutput, 0U)
{}
```

- Verdict: OK
- Conf: H
- Note: 

### 20. `lib_positioning_engine/src/Core/Filters/IFilter.hpp:26` — reinitialize  _(12 lines)_

```cpp
public:
   /// @brief Reinitializes the filter state to the input state.
   ///
   /// @tparam T_STATE Type of the state.
   ///
   /// @param state The state to use for reinitialization.
   ///
   template <typename T_STATE>
   void reinitialize(const T_STATE& state)
   {
      self().reinitializeImpl(state);
   }
```

- Verdict: OK
- Conf: H
- Note: 

### 21. `test/lib_positioning_engine/Core/Corrector/GnssCorrectorTestData.hpp:50` — GnssCorrectorTestCase  _(21 lines)_

```cpp
GnssCorrectorTestCase(
      const GnssKey& inputGnssKey,
      GnssMeasurements inputGnssMeasurements,
      const PositionPolynomial& inputSatPositionPoly,
      Corrections inputCorrections,
      GnssMeasurements inputExpectedGnssMeasurements,
      CorrectionsStatus inputExpectedCorrectionStatus,
      const Vector<DIMENSION_3D>& inputExpectedSatPosition)
      : firstGnssKey(inputGnssKey)
      , firstSanitizedKey(sanitizeKey(inputGnssKey))
      , secondGnssKey(inputGnssKey)
      , secondSanitizedKey(sanitizeKey(inputGnssKey))
      , gnssMeasurements(std::move(inputGnssMeasurements))
      , satPositionPoly(inputSatPositionPoly)
      , corrections(std::move(inputCorrections))
      , expectedGnssMeasurements(std::move(inputExpectedGnssMeasurements))
      , expectedCorrectionStatus(std::move(inputExpectedCorrectionStatus))
      , expectedSatPosition(inputExpectedSatPosition)
   {
      satPositionPolys.emplace(inputGnssKey, inputSatPositionPoly);
   }
```

- Verdict: VIOLATION
- Conf: L
- Note: constructor with runtime 

### 22. `test/lib_positioning_engine/Core/Corrector/GnssCorrectorTest.cpp:121` — populatePolynomialCache  _(13 lines)_

```cpp
/// @brief Register every satellite-position polynomial held by testCase into polys.
///
/// The baseline test case carries one polynomial per satellite that appears in its measurements.
/// Tests should call this helper instead of registering only the primary polynomial, otherwise
/// secondary satellites in the baseline will spuriously fail with a "polynomial not in cache"
/// error.
void populatePolynomialCache(const GnssCorrectorTestCase& testCase, SatellitePolynomialCache& polys)
{
   for (const auto& [key, poly] : testCase.satPositionPolys)
   {
      polys.process(key, std::make_shared<PositionPolynomial>(poly));
   }
}
```

- Verdict: VIOLATION
- Conf: L
- Note: creates Poly and populates with it

### 23. `alpha_conversion/src/Managers/ConversionManager.cpp:532` — createHeaderRecord  _(22 lines)_

```cpp
std::unique_ptr<HlfHeaderRecord> ConversionManager::createHeaderRecord(
   const HlfRecordSubType subType)
{
   switch (subType)
   {
      case HlfRecordSubType::HeaderStartTime:
         return std::make_unique<HlfStartTimeHeaderRecord>();
      case HlfRecordSubType::HeaderInputDescription:
         return std::make_unique<HlfInputDescriptionHeaderRecord>();
      case HlfRecordSubType::HeaderRecordingInformation:
         return std::make_unique<HlfRecordingInformationHeaderRecord>();
      case HlfRecordSubType::HeaderEndTime:
         return std::make_unique<HlfEndTimeHeaderRecord>();
      case HlfRecordSubType::HeaderRecordingDescription:
         return std::make_unique<HlfRecordingDescriptionHeaderRecord>();
      case HlfRecordSubType::HeaderApplicationConfiguration:
         return std::make_unique<HlfApplicationConfigurationHeaderRecord>();
      case HlfRecordSubType::HeaderStaticData:
      default:
         return nullptr;
   }
}
```

- Verdict: OK
- Conf: H
- Note: 

### 24. `alpha_replayer/src/Managers/EngineManager.cpp:23` — add  _(4 lines)_

```cpp
void EngineManager::add(uint16_t streamId, uint16_t mode)
{
   m_engineStreamMap[streamId] = EngineFactory::create(mode, streamId, m_solutionAcceptor);
}
```

- Verdict: OK
- Conf: H
- Note: 

### 25. `lib_common/src/ApiLogging/Hlf/HlfHeaderRecord.cpp:17` — HlfHeaderRecord  _(4 lines)_

```cpp
HlfHeaderRecord::HlfHeaderRecord(HlfRecordSubType const subType)
   : HlfRecord(0U)
   , m_subType(subType)
{}
```

- Verdict: OK
- Conf: H
- Note: 

### 26. `alpha_conversion/src/Serialization/Xml/Core/Serializers/SourceIdXmlSerializer.cpp:10` — serialize  _(4 lines)_

```cpp
void SourceIdXmlSerializer::serialize(mxml_node_t* const node, SourceId const& sourceId)
{
   setAttributeValue(node, AT_NAM_ID, sourceId.value);
}
```

- Verdict: OK
- Conf: H
- Note: 

### 27. `lib_common/src/ApiLogging/Hlf/HlfRecordingDescriptionHeaderRecord.cpp:39` — decodePayload  _(18 lines)_

```cpp
void HlfRecordingDescriptionHeaderRecord::decodePayload(BufferReader& reader)
{
   // HLF Recording Description Header payload consists of:
   // - Sub Type:           1 byte
   // - Description Length: 2 bytes
   // - Description:        0..65535 bytes

   // Read and verify sub-type is correct for this record type
   uint8_t subType{0U};
   reader.read(&subType, sizeof(uint8_t));

   if (subType == static_cast<uint8_t>(getSubType()))
   {
      // Decode description length/data fields
      constexpr size_t descriptionSize = sizeof(m_description);
      HlfHeaderRecord::decodeVarLengthLongString<descriptionSize>(reader, m_description);
   }
}
```

- Verdict: VIOLATION
- Conf: L
- Note: aligns as well as reads

### 28. `alpha_conversion/src/Utility/ArgumentParser.cpp:62` — getOptionValues  _(9 lines)_

```cpp
std::vector<std::string> ArgumentParser::getOptionValues(const std::string& option) const
{
   if (const auto iter = m_options.find(option); iter != m_options.end() && !iter->second.empty())
   {
      return iter->second;
   }

   return {};
}
```

- Verdict: OK
- Conf: H
- Note: 

### 29. `lib_positioning_engine/src/Core/AmbiguityValidation/NullAmbiguityValidator.hpp:28` — reset  _(4 lines)_

```cpp
void reset() const
   {
      // Intentionally empty
   }
```

- Verdict: VIOLATION
- Conf: H
- Note: 

### 30. `lib_positioning_engine/src/Core/States/StateKeySet.hpp:178` — erase  _(9 lines)_

```cpp
/// @brief Removes a GNSS key from the set if it exists.
   /// @param key The GNSS key to remove.
   /// @return Iterator to the element following the erased one, or end() if not found.
   /// @post Iterators (including the end() iterator) and references to the elements at or after the
   /// point of the erase are invalidated.
   Iterator erase(const GnssKey& key)
   {
      return eraseSanitizedKey(T_STATETYPE::sanitizedStateKeySetKey(key));
   }
```

- Verdict: OK
- Conf: H
- Note: 
